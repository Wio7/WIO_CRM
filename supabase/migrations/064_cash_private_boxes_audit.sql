-- Private employee boxes and immutable, owner-visible change history.
ALTER TABLE public.cash_entries ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS public.cash_entry_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('created', 'edited', 'reversed')),
  actor_id uuid NOT NULL,
  actor_name text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason text,
  before_data jsonb,
  after_data jsonb
);
CREATE INDEX IF NOT EXISTS cash_entry_audit_account_time ON public.cash_entry_audit(account_id, changed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS cash_entry_audit_entry ON public.cash_entry_audit(entry_id, changed_at DESC);
ALTER TABLE public.cash_entry_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_entry_audit FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS public.cash_edit_requests (
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  PRIMARY KEY (account_id, request_id)
);
ALTER TABLE public.cash_edit_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_edit_requests FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS cash_entries_read ON public.cash_entries;
CREATE POLICY cash_entries_read ON public.cash_entries FOR SELECT TO authenticated
  USING (public.cash_role(account_id) = 'owner' OR
    (public.cash_role(account_id) IN ('cashier', 'reader') AND created_by = auth.uid()));
DROP POLICY IF EXISTS cash_budgets_read ON public.cash_budgets;
CREATE POLICY cash_budgets_read ON public.cash_budgets FOR SELECT TO authenticated
  USING (public.cash_role(account_id) = 'owner' OR
    (public.cash_role(account_id) IN ('cashier', 'reader') AND created_by = auth.uid()));

-- No direct client DML. This trigger also protects the audit table from later RPC mistakes.
CREATE OR REPLACE FUNCTION public.cash_audit_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor text;
BEGIN
  SELECT COALESCE(NULLIF(full_name, ''), email) INTO v_actor FROM profiles WHERE user_id = auth.uid();
  INSERT INTO public.cash_entry_audit(account_id, entry_id, action, actor_id, actor_name, reason, before_data, after_data)
  VALUES (NEW.account_id, NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN 'created' WHEN NEW.reversal_of IS NOT NULL THEN 'reversed' ELSE 'edited' END,
    auth.uid(), COALESCE(v_actor, NEW.actor_name),
    NULLIF(current_setting('cash.edit_reason', true), ''),
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END, to_jsonb(NEW));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS cash_entry_audit_trigger ON public.cash_entries;
CREATE TRIGGER cash_entry_audit_trigger AFTER INSERT OR UPDATE ON public.cash_entries
FOR EACH ROW EXECUTE FUNCTION public.cash_audit_entry();

CREATE OR REPLACE FUNCTION public.cash_snapshot() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a uuid; r text; viewer uuid := auth.uid();
BEGIN
  SELECT account_id INTO a FROM profiles WHERE user_id = viewer;
  r := cash_role(a);
  IF r IS NULL THEN RAISE EXCEPTION 'Sin acceso financiero' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'accountId', a, 'accountName', (SELECT name FROM accounts WHERE id = a),
    'role', r, 'viewerId', viewer,
    'income', COALESCE((SELECT sum(CASE WHEN reversal_of IS NULL THEN amount_cents ELSE -amount_cents END)
      FROM cash_entries WHERE account_id = a AND (r = 'owner' OR created_by = viewer)
      AND ((kind = 'income' AND reversal_of IS NULL) OR (kind = 'expense' AND reversal_of IS NOT NULL))), 0),
    'expense', COALESCE((SELECT sum(CASE WHEN reversal_of IS NULL THEN amount_cents ELSE -amount_cents END)
      FROM cash_entries WHERE account_id = a AND (r = 'owner' OR created_by = viewer)
      AND ((kind = 'expense' AND reversal_of IS NULL) OR (kind = 'income' AND reversal_of IS NOT NULL))), 0),
    'entries', COALESCE((SELECT jsonb_agg(to_jsonb(e) || jsonb_build_object('reversed', EXISTS(SELECT 1 FROM cash_entries x WHERE x.reversal_of = e.id)) ORDER BY e.created_at DESC, e.id DESC)
      FROM (SELECT * FROM cash_entries WHERE account_id = a AND (r = 'owner' OR created_by = viewer)
        ORDER BY created_at DESC, id DESC LIMIT 100) e), '[]'::jsonb),
    'entryCount', (SELECT count(*) FROM cash_entries WHERE account_id = a AND (r = 'owner' OR created_by = viewer)),
    'budgets', COALESCE((SELECT jsonb_agg(to_jsonb(b) || jsonb_build_object('spent', COALESCE((SELECT sum(CASE WHEN e.kind = 'expense' THEN e.amount_cents ELSE -e.amount_cents END)
      FROM cash_entries e WHERE e.account_id = a AND e.budget_id = b.id AND (r = 'owner' OR e.created_by = viewer)), 0)) ORDER BY b.created_at)
      FROM cash_budgets b WHERE b.account_id = a AND (r = 'owner' OR b.created_by = viewer)), '[]'::jsonb),
    'members', CASE WHEN r = 'owner' THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id', p.user_id, 'name', COALESCE(NULLIF(p.full_name, ''), p.email), 'role', CASE WHEN p.account_role = 'owner' THEN 'owner' ELSE COALESCE(m.role, 'none') END) ORDER BY p.full_name)
      FROM profiles p LEFT JOIN cash_members m ON m.account_id = a AND m.user_id = p.user_id WHERE p.account_id = a), '[]'::jsonb) ELSE '[]'::jsonb END,
    'boxes', CASE WHEN r = 'owner' THEN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'userId', p.user_id, 'name', COALESCE(NULLIF(p.full_name, ''), p.email),
      'income', COALESCE((SELECT sum(CASE WHEN e.reversal_of IS NULL THEN e.amount_cents ELSE -e.amount_cents END) FROM cash_entries e WHERE e.account_id = a AND e.created_by = p.user_id AND ((e.kind = 'income' AND e.reversal_of IS NULL) OR (e.kind = 'expense' AND e.reversal_of IS NOT NULL))), 0),
      'expense', COALESCE((SELECT sum(CASE WHEN e.reversal_of IS NULL THEN e.amount_cents ELSE -e.amount_cents END) FROM cash_entries e WHERE e.account_id = a AND e.created_by = p.user_id AND ((e.kind = 'expense' AND e.reversal_of IS NULL) OR (e.kind = 'income' AND e.reversal_of IS NOT NULL))), 0),
      'entryCount', (SELECT count(*) FROM cash_entries e WHERE e.account_id = a AND e.created_by = p.user_id)) ORDER BY p.full_name)
      FROM profiles p WHERE p.account_id = a AND (p.account_role = 'owner' OR EXISTS (SELECT 1 FROM cash_entries e WHERE e.account_id = a AND e.created_by = p.user_id))), '[]'::jsonb) ELSE '[]'::jsonb END,
    'audit', CASE WHEN r = 'owner' THEN COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.changed_at DESC, h.id DESC)
      FROM (SELECT * FROM cash_entry_audit WHERE account_id = a ORDER BY changed_at DESC, id DESC LIMIT 200) h), '[]'::jsonb) ELSE '[]'::jsonb END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cash_command(p_command jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a uuid; r text; actor text; action text := p_command->>'action'; request uuid; result uuid;
  amount bigint; original cash_entries%ROWTYPE; target uuid; budget uuid; day date; reason text;
BEGIN
  SELECT account_id, COALESCE(NULLIF(full_name, ''), email) INTO a, actor FROM profiles WHERE user_id = auth.uid();
  IF a IS NULL THEN RAISE EXCEPTION 'Usuario sin organización asignada' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM accounts WHERE id = a FOR UPDATE;
  r := cash_role(a);
  IF r IS NULL OR r NOT IN ('owner', 'cashier') THEN RAISE EXCEPTION 'Sin permiso para registrar' USING ERRCODE = '42501'; END IF;

  IF action = 'member' THEN
    IF r <> 'owner' THEN RAISE EXCEPTION 'Solo el propietario administra accesos' USING ERRCODE = '42501'; END IF;
    target := (p_command->>'userId')::uuid;
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = target AND account_id = a AND account_role <> 'owner') THEN
      RAISE EXCEPTION 'Integrante no válido' USING ERRCODE = '22023'; END IF;
    IF p_command->>'role' = 'none' THEN DELETE FROM cash_members WHERE account_id = a AND user_id = target;
    ELSIF p_command->>'role' IN ('reader', 'cashier') THEN
      INSERT INTO cash_members(account_id, user_id, role) VALUES (a, target, p_command->>'role')
      ON CONFLICT (account_id, user_id) DO UPDATE SET role = EXCLUDED.role;
    ELSE RAISE EXCEPTION 'Permiso no válido' USING ERRCODE = '22023'; END IF;
    INSERT INTO cash_access_log(account_id, actor_id, target_id, role) VALUES (a, auth.uid(), target, p_command->>'role');
    RETURN target;
  END IF;

  request := (p_command->>'requestId')::uuid;
  IF request IS NULL THEN RAISE EXCEPTION 'Falta identificador' USING ERRCODE = '22023'; END IF;
  IF action = 'edit' THEN
    SELECT entry_id INTO result FROM cash_edit_requests WHERE account_id = a AND request_id = request;
    IF result IS NOT NULL THEN RETURN result; END IF;
  END IF;
  IF action = 'budget' THEN
    SELECT id INTO result FROM cash_budgets WHERE id = request AND account_id = a;
    IF result IS NOT NULL THEN RETURN result; END IF;
    INSERT INTO cash_budgets(id, account_id, name, amount_cents, created_by)
      VALUES (request, a, trim(p_command->>'name'), (p_command->>'amountCents')::bigint, auth.uid());
    RETURN request;
  END IF;
  SELECT id INTO result FROM cash_entries WHERE account_id = a AND request_id = request;
  IF result IS NOT NULL THEN RETURN result; END IF;

  IF action IN ('edit', 'reverse') THEN
    SELECT * INTO original FROM cash_entries WHERE id = (p_command->>'entryId')::uuid AND account_id = a;
    IF original.id IS NULL OR original.reversal_of IS NOT NULL OR EXISTS (SELECT 1 FROM cash_entries WHERE reversal_of = original.id) THEN
      RAISE EXCEPTION 'Este movimiento no se puede modificar' USING ERRCODE = '22023'; END IF;
    IF r <> 'owner' AND original.created_by <> auth.uid() THEN
      RAISE EXCEPTION 'Solo puedes modificar tu propia caja' USING ERRCODE = '42501'; END IF;
    reason := trim(COALESCE(p_command->>'reason', ''));
    IF length(reason) NOT BETWEEN 3 AND 180 THEN RAISE EXCEPTION 'Indica el motivo del cambio' USING ERRCODE = '22023'; END IF;
    PERFORM set_config('cash.edit_reason', reason, true);
    IF action = 'reverse' THEN
      INSERT INTO cash_entries(account_id, request_id, kind, amount_cents, concept, counterparty, occurred_on, budget_id, reversal_of, created_by, actor_name)
      VALUES (a, request, CASE WHEN original.kind = 'income' THEN 'expense' ELSE 'income' END,
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
    IF budget IS NOT NULL AND (original.kind <> 'expense' OR NOT EXISTS (SELECT 1 FROM cash_budgets WHERE id = budget AND account_id = a AND (r = 'owner' OR created_by = auth.uid()))) THEN
      RAISE EXCEPTION 'Presupuesto no válido' USING ERRCODE = '22023'; END IF;
    UPDATE cash_entries SET amount_cents = amount, concept = trim(p_command->>'concept'),
      counterparty = trim(p_command->>'counterparty'), occurred_on = day, budget_id = budget,
      updated_at = clock_timestamp() WHERE id = original.id RETURNING id INTO result;
    INSERT INTO cash_edit_requests(account_id, request_id, entry_id) VALUES (a, request, result);
    RETURN result;
  END IF;

  IF action <> 'entry' THEN RAISE EXCEPTION 'Operación no válida' USING ERRCODE = '22023'; END IF;
  amount := (p_command->>'amountCents')::bigint;
  budget := NULLIF(p_command->>'budgetId', '')::uuid;
  day := (p_command->>'date')::date;
  IF day IS NULL OR day > (now() AT TIME ZONE 'America/Lima')::date OR day < '2000-01-01'::date THEN
    RAISE EXCEPTION 'Fecha no válida' USING ERRCODE = '22023'; END IF;
  IF budget IS NOT NULL AND (p_command->>'kind' <> 'expense' OR NOT EXISTS (SELECT 1 FROM cash_budgets WHERE id = budget AND account_id = a AND (r = 'owner' OR created_by = auth.uid()))) THEN
    RAISE EXCEPTION 'Presupuesto no válido' USING ERRCODE = '22023'; END IF;
  INSERT INTO cash_entries(account_id, request_id, kind, amount_cents, concept, counterparty, occurred_on, budget_id, created_by, actor_name)
    VALUES (a, request, p_command->>'kind', amount, trim(p_command->>'concept'), trim(p_command->>'counterparty'), day, budget, auth.uid(), actor) RETURNING id INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.cash_export() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a uuid; r text; viewer uuid := auth.uid();
BEGIN
  SELECT account_id INTO a FROM profiles WHERE user_id = viewer;
  r := cash_role(a);
  IF r IS NULL THEN RAISE EXCEPTION 'Sin acceso financiero' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'entries', COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at, e.id) FROM cash_entries e WHERE e.account_id = a AND (r = 'owner' OR e.created_by = viewer)), '[]'::jsonb),
    'audit', CASE WHEN r = 'owner' THEN COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.changed_at, h.id) FROM cash_entry_audit h WHERE h.account_id = a), '[]'::jsonb) ELSE '[]'::jsonb END);
END;
$$;
REVOKE ALL ON FUNCTION public.cash_export() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_export() TO authenticated;
