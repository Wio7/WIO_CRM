-- Golden Caja by WhatsApp: the team writes to the same Golden Habitat number
-- and, instead of being served as a customer, talks to the Caja assistant.
-- The webhook runs with the service key, so every cash read or write goes
-- through cash_as_user(): it runs the regular cash functions AS the
-- recognized person, with exactly the permissions they have in the app.
-- Built and served by Wio CRM (src/lib/asistentes-whatsapp); the same file
-- lives in both repositories.
BEGIN;

-- 1. Organizations where the team mode is on. Starts empty: add Golden
-- Habitat by hand once its people have their phone in profiles.phone.
CREATE TABLE IF NOT EXISTS public.whatsapp_team_accounts (
  account_id uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Where each person is: the mode they chose, the day they were last
-- greeted and when they last wrote (WhatsApp's 24-hour window).
CREATE TABLE IF NOT EXISTS public.whatsapp_team_sessions (
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mode text CHECK (mode IS NULL OR mode IN ('caja', 'app', 'legal', 'cliente')),
  greeted_on date,
  last_inbound_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);

-- 3. One thread per person and mode. A mode never reads another's thread.
CREATE TABLE IF NOT EXISTS public.whatsapp_team_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('caja', 'app', 'legal')),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS whatsapp_team_messages_thread
  ON public.whatsapp_team_messages(user_id, mode, created_at DESC);

-- 4. Movements waiting for the "Sí, guardar" tap. The request id travels in
-- the command, so a double tap saves once.
CREATE TABLE IF NOT EXISTS public.whatsapp_team_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  command jsonb NOT NULL,
  summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'saved', 'cancelled', 'failed')),
  result_id uuid,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS whatsapp_team_drafts_user ON public.whatsapp_team_drafts(user_id, created_at DESC);

ALTER TABLE public.whatsapp_team_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_team_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_team_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_team_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_team_accounts, public.whatsapp_team_sessions, public.whatsapp_team_messages,
  public.whatsapp_team_drafts FROM PUBLIC, anon, authenticated;

-- 5. Who is writing. Phones are compared by their last 9 digits (a Peruvian
-- mobile), so "+51 999 888 777" and "999888777" are the same person. A cash
-- owner counts even when their profile points at another organization (074).
CREATE OR REPLACE FUNCTION public.whatsapp_team_member(p_account uuid, p_phone text)
RETURNS TABLE (user_id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.user_id, COALESCE(NULLIF(split_part(trim(p.full_name), ' ', 1), ''), p.email)
  FROM public.profiles p
  WHERE EXISTS (SELECT 1 FROM public.whatsapp_team_accounts t WHERE t.account_id = p_account)
    AND length(regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g')) >= 9
    AND right(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g'), 9) = right(regexp_replace(p_phone, '\D', '', 'g'), 9)
    AND (p.account_id = p_account
      OR EXISTS (SELECT 1 FROM public.cash_owners o WHERE o.account_id = p_account AND o.user_id = p.user_id))
  ORDER BY EXISTS (SELECT 1 FROM public.cash_owners o WHERE o.account_id = p_account AND o.user_id = p.user_id) DESC, p.user_id
  LIMIT 1;
$$;

-- 6. The nightly summary goes to the cash owners of each enabled organization.
CREATE OR REPLACE FUNCTION public.whatsapp_team_digest_recipients()
RETURNS TABLE (account_id uuid, user_id uuid, name text, phone text, last_inbound_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.account_id, o.user_id, COALESCE(NULLIF(split_part(trim(p.full_name), ' ', 1), ''), p.email),
    regexp_replace(p.phone, '\D', '', 'g'), s.last_inbound_at
  FROM public.cash_owners o
  JOIN public.whatsapp_team_accounts t ON t.account_id = o.account_id
  JOIN public.profiles p ON p.user_id = o.user_id
  LEFT JOIN public.whatsapp_team_sessions s ON s.account_id = o.account_id AND s.user_id = o.user_id
  WHERE length(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g')) >= 9;
$$;

-- 7. A day at a glance for every box the person can see: balance, what came
-- in and went out (registered that day), large expenses, the day's closure
-- and pending replenishments.
CREATE OR REPLACE FUNCTION public.cash_wa_overview(p_day date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a uuid;
BEGIN
  a := public.cash_account_id();
  IF a IS NULL THEN RAISE EXCEPTION 'Sin organización' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object('day', p_day, 'isOwner', public.cash_is_owner(),
    'accountName', (SELECT name FROM public.accounts WHERE id = a),
    'boxes', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'icon', c.icon, 'role', public.cash_company_role(c.id),
      'largeExpenseCents', c.large_expense_cents,
      'balanceCents', COALESCE((SELECT sum(CASE WHEN e.kind = 'income' THEN e.amount_cents ELSE -e.amount_cents END)
        FROM public.cash_entries e WHERE e.company_id = c.id), 0),
      'cashCents', COALESCE((SELECT sum(CASE WHEN e.kind = 'income' THEN e.amount_cents ELSE -e.amount_cents END)
        FROM public.cash_entries e WHERE e.company_id = c.id AND e.payment_method = 'cash'), 0),
      'inCents', COALESCE((SELECT sum(e.amount_cents) FROM public.cash_entries e
        WHERE e.company_id = c.id AND e.kind = 'income' AND e.transfer_id IS NULL AND (e.created_at AT TIME ZONE 'America/Lima')::date = p_day), 0),
      'outCents', COALESCE((SELECT sum(e.amount_cents) FROM public.cash_entries e
        WHERE e.company_id = c.id AND e.kind = 'expense' AND e.transfer_id IS NULL AND (e.created_at AT TIME ZONE 'America/Lima')::date = p_day), 0),
      'transferInCents', COALESCE((SELECT sum(e.amount_cents) FROM public.cash_entries e
        WHERE e.company_id = c.id AND e.kind = 'income' AND e.transfer_id IS NOT NULL AND (e.created_at AT TIME ZONE 'America/Lima')::date = p_day), 0),
      'transferOutCents', COALESCE((SELECT sum(e.amount_cents) FROM public.cash_entries e
        WHERE e.company_id = c.id AND e.kind = 'expense' AND e.transfer_id IS NOT NULL AND (e.created_at AT TIME ZONE 'America/Lima')::date = p_day), 0),
      'count', (SELECT count(*) FROM public.cash_entries e WHERE e.company_id = c.id AND (e.created_at AT TIME ZONE 'America/Lima')::date = p_day),
      'largeExpenses', COALESCE((SELECT jsonb_agg(jsonb_build_object('amountCents', e.amount_cents, 'concept', e.concept,
          'actorName', e.actor_name, 'justification', e.justification) ORDER BY e.created_at)
        FROM public.cash_entries e WHERE e.company_id = c.id AND e.kind = 'expense' AND e.transfer_id IS NULL AND e.reversal_of IS NULL
          AND e.amount_cents > c.large_expense_cents AND (e.created_at AT TIME ZONE 'America/Lima')::date = p_day), '[]'::jsonb),
      'closure', (SELECT jsonb_build_object('expectedCents', x.expected_cents, 'countedCents', x.counted_cents, 'diffCents', x.diff_cents,
          'reason', x.reason, 'actorName', x.actor_name)
        FROM public.cash_closures x WHERE x.company_id = c.id AND x.day = p_day ORDER BY x.created_at DESC LIMIT 1),
      'pendingReplenishments', COALESCE((SELECT jsonb_agg(jsonb_build_object('amountCents', r.amount_cents, 'reason', r.reason,
          'requesterName', r.requester_name, 'createdAt', r.created_at) ORDER BY r.created_at)
        FROM public.cash_replenishments r WHERE r.company_id = c.id AND r.status = 'pending'), '[]'::jsonb)
    ) ORDER BY c.sort_order, c.name)
    FROM public.cash_companies c
    WHERE c.account_id = a AND c.archived_at IS NULL AND public.cash_company_role(c.id) IS NOT NULL), '[]'::jsonb));
END;
$$;

-- 8. Movements by date (the day it happened), with optional box, kind,
-- category, minimum amount and text; totals cover the whole filter.
CREATE OR REPLACE FUNCTION public.cash_wa_entries(p_filter jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a uuid; company uuid := NULLIF(p_filter->>'companyId', '')::uuid;
  d_from date := COALESCE(NULLIF(p_filter->>'from', '')::date, (now() AT TIME ZONE 'America/Lima')::date);
  d_to date := COALESCE(NULLIF(p_filter->>'to', '')::date, (now() AT TIME ZONE 'America/Lima')::date);
  v_kind text := NULLIF(p_filter->>'kind', ''); v_category text := NULLIF(p_filter->>'category', '');
  v_min bigint := COALESCE(NULLIF(p_filter->>'minCents', '')::bigint, 0); v_text text := NULLIF(trim(COALESCE(p_filter->>'text', '')), '');
  v_limit int := LEAST(GREATEST(COALESCE(NULLIF(p_filter->>'limit', '')::int, 30), 1), 100);
BEGIN
  a := public.cash_account_id();
  IF a IS NULL THEN RAISE EXCEPTION 'Sin organización' USING ERRCODE = '42501'; END IF;
  IF company IS NOT NULL AND (public.cash_company_role(company) IS NULL
      OR NOT EXISTS (SELECT 1 FROM public.cash_companies WHERE id = company AND account_id = a)) THEN
    RAISE EXCEPTION 'Sin acceso financiero' USING ERRCODE = '42501'; END IF;
  RETURN (
    WITH m AS (
      SELECT e.*, c.name AS company_name, c.icon AS company_icon FROM public.cash_entries e
      JOIN public.cash_companies c ON c.id = e.company_id
      WHERE c.account_id = a AND public.cash_company_role(c.id) IS NOT NULL AND (company IS NULL OR c.id = company)
        AND e.occurred_on BETWEEN d_from AND d_to AND (v_kind IS NULL OR e.kind = v_kind)
        AND (v_category IS NULL OR e.category = v_category) AND e.amount_cents >= v_min
        AND (v_text IS NULL OR e.concept ILIKE '%' || v_text || '%' OR e.counterparty ILIKE '%' || v_text || '%'))
    SELECT jsonb_build_object('from', d_from, 'to', d_to, 'count', (SELECT count(*) FROM m),
      'incomeCents', COALESCE((SELECT sum(amount_cents) FROM m WHERE kind = 'income'), 0),
      'expenseCents', COALESCE((SELECT sum(amount_cents) FROM m WHERE kind = 'expense'), 0),
      'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('box', s.company_name, 'icon', s.company_icon, 'kind', s.kind,
          'amountCents', s.amount_cents, 'concept', s.concept, 'counterparty', s.counterparty, 'category', s.category,
          'method', s.payment_method, 'date', s.occurred_on, 'by', s.actor_name, 'justification', s.justification,
          'transfer', s.transfer_id IS NOT NULL, 'voided', s.reversal_of IS NOT NULL
            OR EXISTS (SELECT 1 FROM public.cash_entries x WHERE x.reversal_of = s.id)) ORDER BY s.occurred_on DESC, s.created_at DESC)
        FROM (SELECT * FROM m ORDER BY occurred_on DESC, created_at DESC LIMIT v_limit) s), '[]'::jsonb)));
END;
$$;
REVOKE ALL ON FUNCTION public.cash_wa_overview(date), public.cash_wa_entries(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_wa_overview(date), public.cash_wa_entries(jsonb) TO authenticated;

-- 9. The only door the webhook uses. It sets the caller to the recognized
-- person for this transaction and runs a whitelisted cash function, so the
-- answer is exactly what that person would see or do in Golden Caja. Writing
-- by WhatsApp is for cash owners only, and always lands with source whatsapp.
CREATE OR REPLACE FUNCTION public.cash_as_user(p_user uuid, p_call text, p_args jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF p_user IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = p_user) THEN
    RAISE EXCEPTION 'Integrante no válido' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  p_args := COALESCE(p_args, '{}'::jsonb);
  CASE p_call
    WHEN 'overview' THEN
      result := public.cash_wa_overview(COALESCE(NULLIF(p_args->>'day', '')::date, (now() AT TIME ZONE 'America/Lima')::date));
    WHEN 'entries' THEN
      result := public.cash_wa_entries(p_args);
    WHEN 'month_report' THEN
      result := public.cash_month_report(NULLIF(p_args->>'companyId', '')::uuid,
        COALESCE(NULLIF(p_args->>'month', '')::date, (now() AT TIME ZONE 'America/Lima')::date));
    WHEN 'entry' THEN
      IF NOT public.cash_is_owner() THEN
        RAISE EXCEPTION 'Solo los dueños registran movimientos por WhatsApp' USING ERRCODE = '42501'; END IF;
      result := to_jsonb(public.cash_company_command(p_args || jsonb_build_object('action', 'entry', 'source', 'whatsapp')));
    ELSE
      RAISE EXCEPTION 'Consulta no válida' USING ERRCODE = '22023';
  END CASE;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_team_member(uuid, text), public.whatsapp_team_digest_recipients(),
  public.cash_as_user(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_team_member(uuid, text), public.whatsapp_team_digest_recipients(),
  public.cash_as_user(uuid, text, jsonb) TO service_role;

COMMIT;
