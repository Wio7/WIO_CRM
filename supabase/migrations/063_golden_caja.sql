-- Golden Caja Migration for Supabase SQL Editor
-- Compatible with multi-tenant architecture of Wio CRM (Golden Habitat account)

-- 1. Tables
CREATE TABLE IF NOT EXISTS public.cash_members (
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('reader', 'cashier')),
  PRIMARY KEY (account_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.cash_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 99999999999),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, name)
);

CREATE TABLE IF NOT EXISTS public.cash_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('income', 'expense')),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 99999999999),
  concept text NOT NULL CHECK (length(trim(concept)) BETWEEN 1 AND 200),
  counterparty text NOT NULL CHECK (length(trim(counterparty)) BETWEEN 1 AND 160),
  occurred_on date NOT NULL,
  budget_id uuid,
  reversal_of uuid,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  actor_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, request_id),
  UNIQUE (reversal_of),
  FOREIGN KEY (account_id, budget_id) REFERENCES public.cash_budgets(account_id, id),
  FOREIGN KEY (account_id, reversal_of) REFERENCES public.cash_entries(account_id, id)
);

CREATE INDEX IF NOT EXISTS cash_entries_account_date ON public.cash_entries(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.cash_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  target_id uuid NOT NULL REFERENCES auth.users(id),
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Helper Functions & Security RLS
CREATE OR REPLACE FUNCTION public.cash_role(p_account uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p.account_role = 'owner' THEN 'owner' ELSE m.role END
  FROM profiles p LEFT JOIN cash_members m
    ON m.account_id = p.account_id AND m.user_id = p.user_id
  WHERE p.user_id = auth.uid() AND p.account_id = p_account;
$$;

REVOKE ALL ON FUNCTION public.cash_role(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_role(uuid) TO authenticated;

ALTER TABLE public.cash_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_access_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.cash_members, public.cash_budgets, public.cash_entries, public.cash_access_log FROM anon, authenticated;
GRANT SELECT ON public.cash_budgets, public.cash_entries TO authenticated;

DROP POLICY IF EXISTS cash_budgets_read ON public.cash_budgets;
CREATE POLICY cash_budgets_read ON public.cash_budgets FOR SELECT TO authenticated
  USING (public.cash_role(account_id) IS NOT NULL);

DROP POLICY IF EXISTS cash_entries_read ON public.cash_entries;
CREATE POLICY cash_entries_read ON public.cash_entries FOR SELECT TO authenticated
  USING (public.cash_role(account_id) IS NOT NULL);

-- 3. Main Snapshot RPC
CREATE OR REPLACE FUNCTION public.cash_snapshot() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  r text;
  result jsonb;
BEGIN
  SELECT account_id INTO a FROM profiles WHERE user_id = auth.uid();
  r := cash_role(a);
  IF r IS NULL THEN
    RAISE EXCEPTION 'Sin acceso financiero' USING ERRCODE = '42501';
  END IF;
  
  SELECT jsonb_build_object(
    'accountId', a,
    'accountName', (SELECT name FROM accounts WHERE id = a),
    'role', r,
    'income', COALESCE((SELECT sum(CASE WHEN reversal_of IS NULL THEN amount_cents ELSE -amount_cents END)
      FROM cash_entries WHERE account_id = a AND ((kind = 'income' AND reversal_of IS NULL) OR (kind = 'expense' AND reversal_of IS NOT NULL))), 0),
    'expense', COALESCE((SELECT sum(CASE WHEN reversal_of IS NULL THEN amount_cents ELSE -amount_cents END)
      FROM cash_entries WHERE account_id = a AND ((kind = 'expense' AND reversal_of IS NULL) OR (kind = 'income' AND reversal_of IS NOT NULL))), 0),
    'entries', COALESCE((SELECT jsonb_agg(to_jsonb(e) || jsonb_build_object('reversed', EXISTS(SELECT 1 FROM cash_entries x WHERE x.reversal_of = e.id)) ORDER BY e.created_at DESC, e.id)
      FROM (SELECT * FROM cash_entries WHERE account_id = a ORDER BY created_at DESC, id LIMIT 100) e), '[]'::jsonb),
    'entryCount', (SELECT count(*) FROM cash_entries WHERE account_id = a),
    'budgets', COALESCE((SELECT jsonb_agg(to_jsonb(b) || jsonb_build_object('spent', COALESCE((SELECT sum(CASE WHEN e.kind = 'expense' THEN e.amount_cents ELSE -e.amount_cents END) FROM cash_entries e WHERE e.account_id = a AND e.budget_id = b.id), 0)) ORDER BY b.created_at) FROM cash_budgets b WHERE b.account_id = a), '[]'::jsonb),
    'members', CASE WHEN r = 'owner' THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id', p.user_id, 'name', COALESCE(NULLIF(p.full_name, ''), p.email), 'role', CASE WHEN p.account_role = 'owner' THEN 'owner' ELSE COALESCE(m.role, 'none') END) ORDER BY p.full_name) FROM profiles p LEFT JOIN cash_members m ON m.account_id = a AND m.user_id = p.user_id WHERE p.account_id = a), '[]'::jsonb) ELSE '[]'::jsonb END
  ) INTO result;
  
  RETURN result;
END;
$$;

-- 4. Main Command RPC
CREATE OR REPLACE FUNCTION public.cash_command(p_command jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  r text;
  actor text;
  action text := p_command->>'action';
  request uuid;
  result uuid;
  amount bigint;
  original cash_entries%ROWTYPE;
  target uuid;
  budget uuid;
  day date;
BEGIN
  SELECT account_id, COALESCE(NULLIF(full_name, ''), email) INTO a, actor
    FROM profiles WHERE user_id = auth.uid();
  
  IF a IS NULL THEN
    RAISE EXCEPTION 'Usuario sin organización asignada' USING ERRCODE = '42501';
  END IF;

  -- Lock account row to serialize concurrent mutations
  PERFORM 1 FROM accounts WHERE id = a FOR UPDATE;
  
  r := cash_role(a);
  IF r IS NULL OR r NOT IN ('owner', 'cashier') THEN
    RAISE EXCEPTION 'Sin permiso para registrar' USING ERRCODE = '42501';
  END IF;

  IF action = 'member' THEN
    IF r <> 'owner' THEN
      RAISE EXCEPTION 'Solo el propietario administra accesos' USING ERRCODE = '42501';
    END IF;
    target := (p_command->>'userId')::uuid;
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = target AND account_id = a AND account_role <> 'owner') THEN
      RAISE EXCEPTION 'Integrante no válido' USING ERRCODE = '22023';
    END IF;
    IF p_command->>'role' = 'none' THEN
      DELETE FROM cash_members WHERE account_id = a AND user_id = target;
    ELSIF p_command->>'role' IN ('reader', 'cashier') THEN
      INSERT INTO cash_members(account_id, user_id, role) VALUES (a, target, p_command->>'role')
        ON CONFLICT (account_id, user_id) DO UPDATE SET role = EXCLUDED.role;
    ELSE
      RAISE EXCEPTION 'Permiso no válido' USING ERRCODE = '22023';
    END IF;
    INSERT INTO cash_access_log(account_id, actor_id, target_id, role)
      VALUES (a, auth.uid(), target, p_command->>'role');
    RETURN target;
  END IF;

  request := (p_command->>'requestId')::uuid;
  IF request IS NULL THEN
    RAISE EXCEPTION 'Falta identificador' USING ERRCODE = '22023';
  END IF;

  IF action = 'budget' THEN
    SELECT id INTO result FROM cash_budgets WHERE id = request AND account_id = a;
    IF result IS NOT NULL THEN
      RETURN result;
    END IF;
    INSERT INTO cash_budgets(id, account_id, name, amount_cents, created_by)
      VALUES (request, a, trim(p_command->>'name'), (p_command->>'amountCents')::bigint, auth.uid());
    RETURN request;
  END IF;

  SELECT id INTO result FROM cash_entries WHERE account_id = a AND request_id = request;
  IF result IS NOT NULL THEN
    RETURN result;
  END IF;

  IF action = 'reverse' THEN
    SELECT * INTO original FROM cash_entries WHERE id = (p_command->>'entryId')::uuid AND account_id = a;
    IF original.id IS NULL OR original.reversal_of IS NOT NULL OR EXISTS (SELECT 1 FROM cash_entries WHERE reversal_of = original.id) THEN
      RAISE EXCEPTION 'Este movimiento no se puede anular' USING ERRCODE = '22023';
    END IF;
    IF length(trim(COALESCE(p_command->>'reason', ''))) NOT BETWEEN 3 AND 180 THEN
      RAISE EXCEPTION 'Indica el motivo de anulación' USING ERRCODE = '22023';
    END IF;
    INSERT INTO cash_entries(account_id, request_id, kind, amount_cents, concept, counterparty, occurred_on, budget_id, reversal_of, created_by, actor_name)
      VALUES (a, request, CASE WHEN original.kind = 'income' THEN 'expense' ELSE 'income' END,
        original.amount_cents, 'Anulación: ' || trim(p_command->>'reason'), original.counterparty,
        (now() AT TIME ZONE 'America/Lima')::date, original.budget_id, original.id, auth.uid(), actor) RETURNING id INTO result;
  ELSIF action = 'entry' THEN
    amount := (p_command->>'amountCents')::bigint;
    budget := NULLIF(p_command->>'budgetId', '')::uuid;
    day := (p_command->>'date')::date;
    IF day IS NULL OR day > (now() AT TIME ZONE 'America/Lima')::date OR day < '2000-01-01'::date THEN
      RAISE EXCEPTION 'Fecha no válida' USING ERRCODE = '22023';
    END IF;
    IF budget IS NOT NULL AND (p_command->>'kind' <> 'expense' OR NOT EXISTS (SELECT 1 FROM cash_budgets WHERE id = budget AND account_id = a)) THEN
      RAISE EXCEPTION 'Presupuesto no válido' USING ERRCODE = '22023';
    END IF;
    INSERT INTO cash_entries(account_id, request_id, kind, amount_cents, concept, counterparty, occurred_on, budget_id, created_by, actor_name)
      VALUES (a, request, p_command->>'kind', amount, trim(p_command->>'concept'), trim(p_command->>'counterparty'), day, budget, auth.uid(), actor) RETURNING id INTO result;
  ELSE
    RAISE EXCEPTION 'Operación no válida' USING ERRCODE = '22023';
  END IF;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.cash_snapshot(), public.cash_command(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_snapshot(), public.cash_command(jsonb) TO authenticated;

DO $$ 
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.cash_entries, public.cash_budgets;
  END IF;
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;
