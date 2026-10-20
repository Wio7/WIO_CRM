-- Multiple independent financial companies inside one Wio organization.
-- The existing account's cash records remain in its namesake company.
CREATE TABLE IF NOT EXISTS public.cash_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, name)
);
INSERT INTO public.cash_companies(id, account_id, name, created_by)
SELECT a.id, a.id, a.name, a.owner_user_id FROM public.accounts a
ON CONFLICT (id) DO NOTHING;

-- These are empty ledgers. Only an organization named Golden Habitat is seeded.
INSERT INTO public.cash_companies(account_id, name, created_by)
SELECT a.id, names.name, a.owner_user_id
FROM public.accounts a CROSS JOIN (VALUES ('Cafetería'), ('Restaurante'), ('La Jato · Hacienda')) AS names(name)
WHERE lower(a.name) LIKE '%golden habitat%'
ON CONFLICT (account_id, name) DO NOTHING;

ALTER TABLE public.cash_budgets ADD COLUMN IF NOT EXISTS company_id uuid;
ALTER TABLE public.cash_entries ADD COLUMN IF NOT EXISTS company_id uuid;
UPDATE public.cash_budgets SET company_id = account_id WHERE company_id IS NULL;
UPDATE public.cash_entries SET company_id = account_id WHERE company_id IS NULL;
ALTER TABLE public.cash_budgets ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.cash_entries ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.cash_budgets ADD CONSTRAINT cash_budgets_company_fk FOREIGN KEY (account_id, company_id)
  REFERENCES public.cash_companies(account_id, id);
ALTER TABLE public.cash_entries ADD CONSTRAINT cash_entries_company_fk FOREIGN KEY (account_id, company_id)
  REFERENCES public.cash_companies(account_id, id);
CREATE INDEX IF NOT EXISTS cash_entries_company_date ON public.cash_entries(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cash_budgets_company ON public.cash_budgets(company_id);

CREATE TABLE IF NOT EXISTS public.cash_company_members (
  company_id uuid NOT NULL REFERENCES public.cash_companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('reader', 'cashier')),
  PRIMARY KEY (company_id, user_id)
);
INSERT INTO public.cash_company_members(company_id, user_id, role)
SELECT m.account_id, m.user_id, m.role FROM public.cash_members m
ON CONFLICT (company_id, user_id) DO NOTHING;
ALTER TABLE public.cash_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_company_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_companies, public.cash_company_members FROM PUBLIC, anon, authenticated;

ALTER TABLE public.cash_entry_audit ADD COLUMN IF NOT EXISTS company_id uuid;
UPDATE public.cash_entry_audit h SET company_id = e.company_id
FROM public.cash_entries e WHERE e.id = h.entry_id AND h.company_id IS NULL;
ALTER TABLE public.cash_entry_audit ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE public.cash_entry_audit ADD CONSTRAINT cash_entry_audit_company_fk FOREIGN KEY (account_id, company_id)
  REFERENCES public.cash_companies(account_id, id);
CREATE INDEX IF NOT EXISTS cash_entry_audit_company_time ON public.cash_entry_audit(company_id, changed_at DESC, id DESC);
ALTER TABLE public.cash_access_log ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.cash_companies(id);

CREATE OR REPLACE FUNCTION public.cash_company_role(p_company uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p.account_role = 'owner' THEN 'owner' ELSE m.role END
  FROM public.cash_companies c JOIN public.profiles p ON p.account_id = c.account_id AND p.user_id = auth.uid()
  LEFT JOIN public.cash_company_members m ON m.company_id = c.id AND m.user_id = p.user_id
  WHERE c.id = p_company;
$$;
REVOKE ALL ON FUNCTION public.cash_company_role(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_company_role(uuid) TO authenticated;

DROP POLICY IF EXISTS cash_budgets_read ON public.cash_budgets;
CREATE POLICY cash_budgets_read ON public.cash_budgets FOR SELECT TO authenticated
  USING (public.cash_company_role(company_id) = 'owner' OR
    (public.cash_company_role(company_id) IN ('cashier', 'reader') AND created_by = auth.uid()));
DROP POLICY IF EXISTS cash_entries_read ON public.cash_entries;
CREATE POLICY cash_entries_read ON public.cash_entries FOR SELECT TO authenticated
  USING (public.cash_company_role(company_id) = 'owner' OR
    (public.cash_company_role(company_id) IN ('cashier', 'reader') AND created_by = auth.uid()));

CREATE OR REPLACE FUNCTION public.cash_audit_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor text;
BEGIN
  SELECT COALESCE(NULLIF(full_name, ''), email) INTO v_actor FROM public.profiles WHERE user_id = auth.uid();
  INSERT INTO public.cash_entry_audit(account_id, company_id, entry_id, action, actor_id, actor_name, reason, before_data, after_data)
  VALUES (NEW.account_id, NEW.company_id, NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN CASE WHEN NEW.reversal_of IS NOT NULL THEN 'reversed' ELSE 'created' END ELSE 'edited' END,
    auth.uid(), COALESCE(v_actor, NEW.actor_name), NULLIF(current_setting('cash.edit_reason', true), ''),
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END, to_jsonb(NEW));
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.cash_company_list() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a uuid;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL THEN RAISE EXCEPTION 'Sin organización' USING ERRCODE = '42501'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
    'role', public.cash_company_role(c.id)) ORDER BY c.name)
    FROM public.cash_companies c WHERE c.account_id = a AND public.cash_company_role(c.id) IS NOT NULL), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.cash_company_snapshot(p_company uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a uuid; r text; viewer uuid := auth.uid(); company_name text;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = viewer;
  SELECT name INTO company_name FROM public.cash_companies WHERE id = p_company AND account_id = a;
  r := public.cash_company_role(p_company);
  IF company_name IS NULL OR r IS NULL THEN RAISE EXCEPTION 'Sin acceso financiero' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'accountId', a, 'companyId', p_company, 'accountName', company_name, 'role', r, 'viewerId', viewer,
    'income', COALESCE((SELECT sum(CASE WHEN reversal_of IS NULL THEN amount_cents ELSE -amount_cents END)
      FROM public.cash_entries WHERE company_id = p_company AND (r = 'owner' OR created_by = viewer)
      AND ((kind = 'income' AND reversal_of IS NULL) OR (kind = 'expense' AND reversal_of IS NOT NULL))), 0),
    'expense', COALESCE((SELECT sum(CASE WHEN reversal_of IS NULL THEN amount_cents ELSE -amount_cents END)
      FROM public.cash_entries WHERE company_id = p_company AND (r = 'owner' OR created_by = viewer)
      AND ((kind = 'expense' AND reversal_of IS NULL) OR (kind = 'income' AND reversal_of IS NOT NULL))), 0),
    'entries', COALESCE((SELECT jsonb_agg(to_jsonb(e) || jsonb_build_object('reversed', EXISTS(SELECT 1 FROM public.cash_entries x WHERE x.reversal_of = e.id)) ORDER BY e.created_at DESC, e.id DESC)
      FROM (SELECT * FROM public.cash_entries WHERE company_id = p_company AND (r = 'owner' OR created_by = viewer)
        ORDER BY created_at DESC, id DESC LIMIT 100) e), '[]'::jsonb),
    'entryCount', (SELECT count(*) FROM public.cash_entries WHERE company_id = p_company AND (r = 'owner' OR created_by = viewer)),
    'budgets', COALESCE((SELECT jsonb_agg(to_jsonb(b) || jsonb_build_object('spent', COALESCE((SELECT sum(CASE WHEN e.kind = 'expense' THEN e.amount_cents ELSE -e.amount_cents END)
      FROM public.cash_entries e WHERE e.company_id = p_company AND e.budget_id = b.id AND (r = 'owner' OR e.created_by = viewer)), 0)) ORDER BY b.created_at)
      FROM public.cash_budgets b WHERE b.company_id = p_company AND (r = 'owner' OR b.created_by = viewer)), '[]'::jsonb),
    'members', CASE WHEN r = 'owner' THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id', p.user_id, 'name', COALESCE(NULLIF(p.full_name, ''), p.email), 'role', CASE WHEN p.account_role = 'owner' THEN 'owner' ELSE COALESCE(m.role, 'none') END) ORDER BY p.full_name)
      FROM public.profiles p LEFT JOIN public.cash_company_members m ON m.company_id = p_company AND m.user_id = p.user_id WHERE p.account_id = a), '[]'::jsonb) ELSE '[]'::jsonb END,
    'boxes', CASE WHEN r = 'owner' THEN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'userId', p.user_id, 'name', COALESCE(NULLIF(p.full_name, ''), p.email),
      'income', COALESCE((SELECT sum(CASE WHEN e.reversal_of IS NULL THEN e.amount_cents ELSE -e.amount_cents END) FROM public.cash_entries e WHERE e.company_id = p_company AND e.created_by = p.user_id AND ((e.kind = 'income' AND e.reversal_of IS NULL) OR (e.kind = 'expense' AND e.reversal_of IS NOT NULL))), 0),
      'expense', COALESCE((SELECT sum(CASE WHEN e.reversal_of IS NULL THEN e.amount_cents ELSE -e.amount_cents END) FROM public.cash_entries e WHERE e.company_id = p_company AND e.created_by = p.user_id AND ((e.kind = 'expense' AND e.reversal_of IS NULL) OR (e.kind = 'income' AND e.reversal_of IS NOT NULL))), 0),
      'entryCount', (SELECT count(*) FROM public.cash_entries e WHERE e.company_id = p_company AND e.created_by = p.user_id)) ORDER BY p.full_name)
      FROM public.profiles p WHERE p.account_id = a AND (p.account_role = 'owner' OR EXISTS (SELECT 1 FROM public.cash_entries e WHERE e.company_id = p_company AND e.created_by = p.user_id))), '[]'::jsonb) ELSE '[]'::jsonb END,
    'audit', CASE WHEN r = 'owner' THEN COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.changed_at DESC, h.id DESC)
      FROM (SELECT * FROM public.cash_entry_audit WHERE company_id = p_company ORDER BY changed_at DESC, id DESC LIMIT 200) h), '[]'::jsonb) ELSE '[]'::jsonb END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cash_company_command(p_command jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a uuid; r text; actor text; action text := p_command->>'action'; request uuid; result uuid;
  amount bigint; original public.cash_entries%ROWTYPE; target uuid; budget uuid; day date; reason text;
  company uuid := NULLIF(p_command->>'companyId', '')::uuid;
BEGIN
  SELECT account_id, COALESCE(NULLIF(full_name, ''), email) INTO a, actor FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL THEN RAISE EXCEPTION 'Usuario sin organización' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.accounts WHERE id = a FOR UPDATE;
  request := (p_command->>'requestId')::uuid;
  IF action = 'company' THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND account_id = a AND account_role = 'owner') THEN
      RAISE EXCEPTION 'Solo el propietario crea empresas' USING ERRCODE = '42501'; END IF;
    IF request IS NULL OR length(trim(COALESCE(p_command->>'name', ''))) NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'Nombre no válido' USING ERRCODE = '22023'; END IF;
    INSERT INTO public.cash_companies(id, account_id, name, created_by)
      VALUES (request, a, trim(p_command->>'name'), auth.uid()) ON CONFLICT (id) DO NOTHING;
    IF NOT EXISTS (SELECT 1 FROM public.cash_companies WHERE id = request AND account_id = a) THEN
      RAISE EXCEPTION 'Empresa no válida' USING ERRCODE = '42501'; END IF;
    RETURN request;
  END IF;
  IF company IS NULL OR NOT EXISTS (SELECT 1 FROM public.cash_companies WHERE id = company AND account_id = a) THEN
    RAISE EXCEPTION 'Empresa no válida' USING ERRCODE = '42501'; END IF;
  r := public.cash_company_role(company);
  IF r NOT IN ('owner', 'cashier') OR r IS NULL THEN RAISE EXCEPTION 'Sin permiso para registrar' USING ERRCODE = '42501'; END IF;
  IF action = 'member' THEN
    IF r <> 'owner' THEN RAISE EXCEPTION 'Solo el propietario administra accesos' USING ERRCODE = '42501'; END IF;
    target := (p_command->>'userId')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = target AND account_id = a AND account_role <> 'owner') THEN
      RAISE EXCEPTION 'Integrante no válido' USING ERRCODE = '22023'; END IF;
    IF p_command->>'role' = 'none' THEN DELETE FROM public.cash_company_members WHERE company_id = company AND user_id = target;
    ELSIF p_command->>'role' IN ('reader', 'cashier') THEN
      INSERT INTO public.cash_company_members(company_id, user_id, role) VALUES (company, target, p_command->>'role')
      ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role;
    ELSE RAISE EXCEPTION 'Permiso no válido' USING ERRCODE = '22023'; END IF;
    INSERT INTO public.cash_access_log(account_id, company_id, actor_id, target_id, role)
      VALUES (a, company, auth.uid(), target, p_command->>'role');
    RETURN target;
  END IF;
  IF request IS NULL THEN RAISE EXCEPTION 'Falta identificador' USING ERRCODE = '22023'; END IF;
  IF action = 'edit' THEN
    SELECT er.entry_id INTO result FROM public.cash_edit_requests er JOIN public.cash_entries e ON e.id = er.entry_id
      WHERE er.account_id = a AND er.request_id = request AND e.company_id = company;
    IF result IS NOT NULL THEN RETURN result; END IF;
  END IF;
  IF action = 'budget' THEN
    SELECT id INTO result FROM public.cash_budgets WHERE id = request AND company_id = company;
    IF result IS NOT NULL THEN RETURN result; END IF;
    INSERT INTO public.cash_budgets(id, account_id, company_id, name, amount_cents, created_by)
      VALUES (request, a, company, trim(p_command->>'name'), (p_command->>'amountCents')::bigint, auth.uid());
    RETURN request;
  END IF;
  SELECT id INTO result FROM public.cash_entries WHERE company_id = company AND request_id = request;
  IF result IS NOT NULL THEN RETURN result; END IF;
  IF action IN ('edit', 'reverse') THEN
    SELECT * INTO original FROM public.cash_entries WHERE id = (p_command->>'entryId')::uuid AND company_id = company;
    IF original.id IS NULL OR original.reversal_of IS NOT NULL OR EXISTS (SELECT 1 FROM public.cash_entries WHERE reversal_of = original.id) THEN
      RAISE EXCEPTION 'Este movimiento no se puede modificar' USING ERRCODE = '22023'; END IF;
    IF r <> 'owner' AND original.created_by <> auth.uid() THEN
      RAISE EXCEPTION 'Solo puedes modificar tu propia caja' USING ERRCODE = '42501'; END IF;
    reason := trim(COALESCE(p_command->>'reason', ''));
    IF length(reason) NOT BETWEEN 3 AND 180 THEN RAISE EXCEPTION 'Indica el motivo del cambio' USING ERRCODE = '22023'; END IF;
    PERFORM set_config('cash.edit_reason', reason, true);
    IF action = 'reverse' THEN
      INSERT INTO public.cash_entries(account_id, company_id, request_id, kind, amount_cents, concept, counterparty, occurred_on, budget_id, reversal_of, created_by, actor_name)
      VALUES (a, company, request, CASE WHEN original.kind = 'income' THEN 'expense' ELSE 'income' END,
        original.amount_cents, 'Anulación: ' || reason, original.counterparty,
        (now() AT TIME ZONE 'America/Lima')::date, original.budget_id, original.id, original.created_by, actor) RETURNING id INTO result;
      RETURN result;
    END IF;
    IF original.updated_at <> (p_command->>'expectedUpdatedAt')::timestamptz THEN
      RAISE EXCEPTION 'El movimiento cambió. Actualiza antes de editarlo' USING ERRCODE = '40001'; END IF;
    amount := (p_command->>'amountCents')::bigint;
    budget := NULLIF(p_command->>'budgetId', '')::uuid;
    day := (p_command->>'date')::date;
    IF day IS NULL OR day > (now() AT TIME ZONE 'America/Lima')::date OR day < '2000-01-01'::date THEN
      RAISE EXCEPTION 'Fecha no válida' USING ERRCODE = '22023'; END IF;
    IF budget IS NOT NULL AND (original.kind <> 'expense' OR NOT EXISTS (SELECT 1 FROM public.cash_budgets WHERE id = budget AND company_id = company AND (r = 'owner' OR created_by = auth.uid()))) THEN
      RAISE EXCEPTION 'Presupuesto no válido' USING ERRCODE = '22023'; END IF;
    UPDATE public.cash_entries SET amount_cents = amount, concept = trim(p_command->>'concept'),
      counterparty = trim(p_command->>'counterparty'), occurred_on = day, budget_id = budget,
      updated_at = clock_timestamp() WHERE id = original.id RETURNING id INTO result;
    INSERT INTO public.cash_edit_requests(account_id, request_id, entry_id) VALUES (a, request, result);
    RETURN result;
  END IF;
  IF action <> 'entry' THEN RAISE EXCEPTION 'Operación no válida' USING ERRCODE = '22023'; END IF;
  amount := (p_command->>'amountCents')::bigint;
  budget := NULLIF(p_command->>'budgetId', '')::uuid;
  day := (p_command->>'date')::date;
  IF day IS NULL OR day > (now() AT TIME ZONE 'America/Lima')::date OR day < '2000-01-01'::date THEN
    RAISE EXCEPTION 'Fecha no válida' USING ERRCODE = '22023'; END IF;
  IF budget IS NOT NULL AND (p_command->>'kind' <> 'expense' OR NOT EXISTS (SELECT 1 FROM public.cash_budgets WHERE id = budget AND company_id = company AND (r = 'owner' OR created_by = auth.uid()))) THEN
    RAISE EXCEPTION 'Presupuesto no válido' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.cash_entries(account_id, company_id, request_id, kind, amount_cents, concept, counterparty, occurred_on, budget_id, created_by, actor_name)
    VALUES (a, company, request, p_command->>'kind', amount, trim(p_command->>'concept'), trim(p_command->>'counterparty'), day, budget, auth.uid(), actor) RETURNING id INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.cash_company_export(p_company uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a uuid; r text; viewer uuid := auth.uid();
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = viewer;
  r := public.cash_company_role(p_company);
  IF r IS NULL OR NOT EXISTS (SELECT 1 FROM public.cash_companies WHERE id = p_company AND account_id = a) THEN
    RAISE EXCEPTION 'Sin acceso financiero' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'entries', COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at, e.id) FROM public.cash_entries e WHERE e.company_id = p_company AND (r = 'owner' OR e.created_by = viewer)), '[]'::jsonb),
    'audit', CASE WHEN r = 'owner' THEN COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.changed_at, h.id) FROM public.cash_entry_audit h WHERE h.company_id = p_company), '[]'::jsonb) ELSE '[]'::jsonb END);
END;
$$;

REVOKE ALL ON FUNCTION public.cash_snapshot(), public.cash_command(jsonb), public.cash_export() FROM authenticated;
REVOKE ALL ON FUNCTION public.cash_company_list(), public.cash_company_snapshot(uuid), public.cash_company_command(jsonb), public.cash_company_export(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_company_list(), public.cash_company_snapshot(uuid), public.cash_company_command(jsonb), public.cash_company_export(uuid) TO authenticated;
