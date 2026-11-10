-- ============================================================
-- 087_caja_proyecto_rubro.sql — Caja chica mejorada (Wio Suite, fase F3)
--
-- Diseño: docs/superpowers/specs/2026-11-09-areas-pendientes-design.md §3.6
--         y docs/superpowers/specs/2026-11-09-fase-f-apps-y-conexiones-design.md §2, §4, §6.3
-- Casos:  supabase/tests/087_casos.sql (correr DESPUÉS de aplicar esta).
-- Requiere: 063, 064, 065 (caja y varias cajas), 032 (real_estate_projects),
--           084 (is_owner_or_gerencia, is_account_member) y 075 (cash_as_user).
--
-- Qué cambia:
--   1. cash_entries: project_id (proyecto de real_estate_projects),
--      project_general (gasto general, sin proyecto) y rubro (personal,
--      marketing, obra, combi, proveedores, otros). Los tres son opcionales:
--      los gastos viejos y los de WhatsApp sin deducir quedan "sin asignar".
--   2. La clasificación entra por un ajuste de sesión (cash.project_id,
--      cash.rubro, cash.project_general) que lee un trigger BEFORE INSERT.
--      Así NO se reemplaza cash_company_command (que en producción ya es la
--      versión de 069-074) ni se hace un UPDATE que el historial inmutable
--      (070) rechazaría.
--   3. cash_company_entry(jsonb): el gasto nuevo desde la app. Exige rubro y
--      proyecto (o "gasto general") y llama a cash_company_command.
--   4. cash_classify_entry(...): completa o corrige proyecto y rubro de un
--      gasto ya registrado (queda en el historial con motivo).
--   5. cash_as_user (075) pasa projectId / rubro del borrador de WhatsApp.
--   6. cash_companies.responsible_user_id: responsable visible de cada caja
--      (se rellena con el encargado o el dueño de la cuenta).
--   7. cash_form_options y cash_management_panel (gasto por proyecto, rubro,
--      mes y caja) para gerencia, dueño de caja y contabilidad.
--
-- Idempotente — se puede volver a correr.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. Columnas
-- ------------------------------------------------------------
ALTER TABLE public.cash_entries
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.real_estate_projects(id),
  ADD COLUMN IF NOT EXISTS project_general boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rubro text
    CHECK (rubro IS NULL OR rubro IN ('personal', 'marketing', 'obra', 'combi', 'proveedores', 'otros'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_entries_project_xor_general'
                   AND conrelid = 'public.cash_entries'::regclass) THEN
    ALTER TABLE public.cash_entries ADD CONSTRAINT cash_entries_project_xor_general
      CHECK (NOT (project_id IS NOT NULL AND project_general));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS cash_entries_project ON public.cash_entries(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cash_entries_rubro ON public.cash_entries(company_id, rubro);

ALTER TABLE public.cash_companies
  ADD COLUMN IF NOT EXISTS responsible_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Cajas sin responsable: su encargado (el primero por nombre) o, si no hay,
-- el dueño de la cuenta.
UPDATE public.cash_companies c
   SET responsible_user_id = COALESCE(
     (SELECT m.user_id FROM public.cash_company_members m
        JOIN public.profiles p ON p.user_id = m.user_id
       WHERE m.company_id = c.id AND m.role = 'cashier'
       ORDER BY p.full_name, m.user_id LIMIT 1),
     (SELECT a.owner_user_id FROM public.accounts a WHERE a.id = c.account_id))
 WHERE c.responsible_user_id IS NULL;

-- Cajas nuevas: quien las crea queda como responsable hasta que se cambie.
CREATE OR REPLACE FUNCTION public.cash_company_default_responsible() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.responsible_user_id IS NULL THEN NEW.responsible_user_id := NEW.created_by; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS cash_companies_default_responsible ON public.cash_companies;
CREATE TRIGGER cash_companies_default_responsible BEFORE INSERT ON public.cash_companies
  FOR EACH ROW EXECUTE FUNCTION public.cash_company_default_responsible();

-- ------------------------------------------------------------
-- 2. Trigger: toma la clasificación de la sesión al insertar
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cash_entry_apply_classification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_project text := NULLIF(current_setting('cash.project_id', true), '');
  v_rubro   text := NULLIF(current_setting('cash.rubro', true), '');
  v_general boolean := COALESCE(NULLIF(current_setting('cash.project_general', true), '')::boolean, false);
BEGIN
  -- Una anulación hereda la clasificación del movimiento que anula.
  IF NEW.reversal_of IS NOT NULL THEN
    SELECT o.project_id, o.project_general, o.rubro INTO NEW.project_id, NEW.project_general, NEW.rubro
      FROM public.cash_entries o WHERE o.id = NEW.reversal_of;
    RETURN NEW;
  END IF;

  -- Los ajustes se consumen: el siguiente insert de la misma transacción no los hereda.
  PERFORM set_config('cash.project_id', '', true);
  PERFORM set_config('cash.rubro', '', true);
  PERFORM set_config('cash.project_general', '', true);

  IF NEW.kind <> 'expense' OR (v_project IS NULL AND v_rubro IS NULL AND NOT v_general) THEN
    RETURN NEW;
  END IF;
  IF v_rubro IS NOT NULL AND v_rubro NOT IN ('personal', 'marketing', 'obra', 'combi', 'proveedores', 'otros') THEN
    RAISE EXCEPTION 'Rubro no válido' USING ERRCODE = '22023';
  END IF;
  IF v_project IS NOT NULL AND v_general THEN
    RAISE EXCEPTION 'Elige un proyecto o gasto general, no ambos' USING ERRCODE = '22023';
  END IF;
  IF v_project IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.real_estate_projects
                    WHERE id = v_project::uuid AND account_id = NEW.account_id) THEN
      RAISE EXCEPTION 'Proyecto no válido' USING ERRCODE = '22023';
    END IF;
    NEW.project_id := v_project::uuid;
  END IF;
  NEW.project_general := v_general;
  NEW.rubro := v_rubro;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cash_entries_apply_classification ON public.cash_entries;
CREATE TRIGGER cash_entries_apply_classification BEFORE INSERT ON public.cash_entries
  FOR EACH ROW EXECUTE FUNCTION public.cash_entry_apply_classification();

-- ------------------------------------------------------------
-- 3. ¿Quién ve el panel de gerencia?
--    Dueño de la cuenta o super admin, gerencia (084), contabilidad y quien
--    es dueño de alguna caja de la cuenta.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cash_panel_access(p_account uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NOT NULL AND p_account IS NOT NULL AND (
    public.is_owner_or_gerencia(p_account)
    OR (public.is_account_member(p_account, 'agent') AND EXISTS (
          SELECT 1 FROM public.profiles p
           WHERE p.user_id = auth.uid() AND p.account_id = p_account AND p.area = 'contabilidad'))
    OR EXISTS (SELECT 1 FROM public.cash_companies c
                WHERE c.account_id = p_account AND public.cash_company_role(c.id) = 'owner'));
$$;

-- ------------------------------------------------------------
-- 4. Gasto nuevo desde la app: rubro y proyecto obligatorios
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cash_company_entry(p_command jsonb) RETURNS uuid
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_kind    text := p_command->>'kind';
  v_project text := NULLIF(p_command->>'projectId', '');
  v_rubro   text := NULLIF(p_command->>'rubro', '');
  v_general boolean := COALESCE(NULLIF(p_command->>'projectGeneral', '')::boolean, false);
  v_source  text := COALESCE(p_command->>'source', 'manual');
  v_id      uuid;
BEGIN
  IF p_command->>'action' IS DISTINCT FROM 'entry' THEN
    RAISE EXCEPTION 'Operación no válida' USING ERRCODE = '22023';
  END IF;
  IF v_kind = 'expense' THEN
    IF v_source <> 'whatsapp' THEN
      IF v_rubro IS NULL THEN
        RAISE EXCEPTION 'Elige el rubro del gasto' USING ERRCODE = '22023'; END IF;
      IF v_project IS NULL AND NOT v_general THEN
        RAISE EXCEPTION 'Elige el proyecto del gasto, o márcalo como gasto general' USING ERRCODE = '22023'; END IF;
    END IF;
    PERFORM set_config('cash.project_id', COALESCE(v_project, ''), true);
    PERFORM set_config('cash.rubro', COALESCE(v_rubro, ''), true);
    PERFORM set_config('cash.project_general', v_general::text, true);
  END IF;
  v_id := public.cash_company_command(p_command);
  -- Si el pedido ya existía (reintento), el trigger no corrió: limpiar igual.
  PERFORM set_config('cash.project_id', '', true);
  PERFORM set_config('cash.rubro', '', true);
  PERFORM set_config('cash.project_general', '', true);
  RETURN v_id;
END;
$$;

-- ------------------------------------------------------------
-- 5. Completar o corregir la clasificación de un gasto ya registrado
--    Lo puede hacer: el dueño de la caja, quien registró el gasto
--    (encargado) y el panel de gerencia/contabilidad. Queda en el historial.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cash_classify_entry(
  p_entry uuid, p_project uuid, p_general boolean, p_rubro text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e public.cash_entries%ROWTYPE; r text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501'; END IF;
  SELECT * INTO e FROM public.cash_entries WHERE id = p_entry;
  IF e.id IS NULL THEN RAISE EXCEPTION 'Movimiento no encontrado' USING ERRCODE = '22023'; END IF;
  r := COALESCE(public.cash_company_role(e.company_id), '');
  IF NOT (COALESCE(public.cash_panel_access(e.account_id), false) OR r = 'owner'
          OR (r = 'cashier' AND e.created_by = auth.uid())) THEN
    RAISE EXCEPTION 'Sin permiso para clasificar este gasto' USING ERRCODE = '42501';
  END IF;
  IF e.kind <> 'expense' OR e.reversal_of IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.cash_entries x WHERE x.reversal_of = e.id) THEN
    RAISE EXCEPTION 'Solo se clasifican los gastos vigentes' USING ERRCODE = '22023';
  END IF;
  IF p_rubro IS NULL OR p_rubro NOT IN ('personal', 'marketing', 'obra', 'combi', 'proveedores', 'otros') THEN
    RAISE EXCEPTION 'Elige el rubro del gasto' USING ERRCODE = '22023';
  END IF;
  p_general := COALESCE(p_general, false);
  IF (p_project IS NULL) = (NOT p_general) THEN
    RAISE EXCEPTION 'Elige un proyecto, o marca gasto general' USING ERRCODE = '22023';
  END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.real_estate_projects WHERE id = p_project AND account_id = e.account_id) THEN
    RAISE EXCEPTION 'Proyecto no válido' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('cash.edit_reason', 'Proyecto y rubro del gasto', true);
  UPDATE public.cash_entries
     SET project_id = p_project, project_general = p_general, rubro = p_rubro,
         updated_at = clock_timestamp()
   WHERE id = e.id;
  PERFORM set_config('cash.edit_reason', '', true);
  RETURN e.id;
END;
$$;

-- ------------------------------------------------------------
-- 6. Responsable de cada caja
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cash_set_responsible(p_company uuid, p_user uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a uuid;
BEGIN
  SELECT account_id INTO a FROM public.cash_companies WHERE id = p_company;
  IF a IS NULL OR public.cash_company_role(p_company) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Solo el dueño de la caja cambia al responsable' USING ERRCODE = '42501';
  END IF;
  IF p_user IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = p_user AND account_id = a) THEN
    RAISE EXCEPTION 'Responsable no válido' USING ERRCODE = '22023';
  END IF;
  UPDATE public.cash_companies SET responsible_user_id = p_user WHERE id = p_company;
  RETURN p_company;
END;
$$;

-- ------------------------------------------------------------
-- 7. Lo que necesita el formulario y el encabezado de una caja
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cash_form_options(p_company uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a uuid; c public.cash_companies%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.cash_companies WHERE id = p_company;
  IF c.id IS NULL OR public.cash_company_role(p_company) IS NULL THEN
    RAISE EXCEPTION 'Sin acceso financiero' USING ERRCODE = '42501'; END IF;
  a := c.account_id;
  RETURN jsonb_build_object(
    'rubros', jsonb_build_array('personal', 'marketing', 'obra', 'combi', 'proveedores', 'otros'),
    'projects', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) ORDER BY p.name)
                            FROM public.real_estate_projects p WHERE p.account_id = a), '[]'::jsonb),
    'responsible', (SELECT jsonb_build_object('userId', u.user_id, 'name', COALESCE(NULLIF(u.full_name, ''), u.email))
                      FROM public.profiles u WHERE u.user_id = c.responsible_user_id),
    'canPanel', public.cash_panel_access(a),
    'canSetResponsible', public.cash_company_role(p_company) = 'owner',
    'people', CASE WHEN public.cash_company_role(p_company) = 'owner' THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object('userId', u.user_id, 'name', COALESCE(NULLIF(u.full_name, ''), u.email))
                       ORDER BY u.full_name) FROM public.profiles u WHERE u.account_id = a), '[]'::jsonb)
      ELSE '[]'::jsonb END);
END;
$$;

-- Para quien solo tiene el panel (contabilidad, gerencia): ¿hay panel?
CREATE OR REPLACE FUNCTION public.cash_access_info() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('canPanel', COALESCE(
    (SELECT public.cash_panel_access(p.account_id) FROM public.profiles p WHERE p.user_id = auth.uid()), false));
$$;

-- ------------------------------------------------------------
-- 8. Panel de gerencia: gasto por proyecto, rubro, mes y caja
--    p_month: cualquier día del mes (null = todo el historial).
--    p_company: una caja (null = todas). Cuenta los gastos vigentes: no
--    cuenta los anulados ni los pases entre cajas.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cash_management_panel(p_month date DEFAULT NULL, p_company uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_from date := CASE WHEN p_month IS NULL THEN NULL ELSE date_trunc('month', p_month)::date END;
  v_to date := CASE WHEN p_month IS NULL THEN NULL ELSE (date_trunc('month', p_month) + interval '1 month')::date END;
  v_last date := date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'America/Lima')::date))::date;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT public.cash_panel_access(a) THEN
    RAISE EXCEPTION 'Sin acceso al panel de gerencia' USING ERRCODE = '42501'; END IF;
  IF p_company IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.cash_companies WHERE id = p_company AND account_id = a) THEN
    RAISE EXCEPTION 'Caja no válida' USING ERRCODE = '22023'; END IF;

  RETURN (
    WITH todos AS (
      SELECT e.id, e.company_id, e.amount_cents, e.occurred_on, e.project_id, e.project_general, e.rubro,
             e.concept, e.counterparty
        FROM public.cash_entries e
       WHERE e.account_id = a AND e.kind = 'expense' AND e.reversal_of IS NULL
         AND NOT EXISTS (SELECT 1 FROM public.cash_entries x WHERE x.reversal_of = e.id)
         AND to_jsonb(e)->>'transfer_id' IS NULL),
    elegidos AS (SELECT * FROM todos WHERE p_company IS NULL OR company_id = p_company),
    del_mes AS (SELECT * FROM elegidos WHERE v_from IS NULL OR (occurred_on >= v_from AND occurred_on < v_to)),
    cajas_mes AS (SELECT * FROM todos WHERE v_from IS NULL OR (occurred_on >= v_from AND occurred_on < v_to))
    SELECT jsonb_build_object(
      'month', CASE WHEN v_from IS NULL THEN NULL ELSE to_char(v_from, 'YYYY-MM') END,
      'companyId', p_company,
      'totalCents', COALESCE((SELECT sum(amount_cents) FROM del_mes), 0),
      'count', (SELECT count(*) FROM del_mes),
      'unassigned', jsonb_build_object(
        'count', (SELECT count(*) FROM del_mes WHERE rubro IS NULL OR (project_id IS NULL AND NOT project_general)),
        'cents', COALESCE((SELECT sum(amount_cents) FROM del_mes WHERE rubro IS NULL OR (project_id IS NULL AND NOT project_general)), 0)),
      'byProject', COALESCE((SELECT jsonb_agg(row_to_json(t)::jsonb ORDER BY t.cents DESC, t.name) FROM (
          SELECT CASE WHEN d.project_id IS NOT NULL THEN d.project_id::text
                      WHEN d.project_general THEN 'general' ELSE 'sin_asignar' END AS key,
                 d.project_id AS id,
                 CASE WHEN d.project_id IS NOT NULL THEN p.name
                      WHEN d.project_general THEN 'Gasto general' ELSE 'Sin asignar' END AS name,
                 sum(d.amount_cents) AS cents, count(*) AS count
            FROM del_mes d LEFT JOIN public.real_estate_projects p ON p.id = d.project_id
           GROUP BY d.project_id, d.project_general, p.name) t), '[]'::jsonb),
      'byRubro', COALESCE((SELECT jsonb_agg(row_to_json(t)::jsonb ORDER BY t.cents DESC, t.rubro) FROM (
          SELECT COALESCE(rubro, 'sin_asignar') AS rubro, sum(amount_cents) AS cents, count(*) AS count
            FROM del_mes GROUP BY rubro) t), '[]'::jsonb),
      'byCompany', COALESCE((SELECT jsonb_agg(row_to_json(t)::jsonb ORDER BY t.cents DESC, t.name) FROM (
          SELECT c.id, c.name,
                 (SELECT COALESCE(NULLIF(u.full_name, ''), u.email) FROM public.profiles u WHERE u.user_id = c.responsible_user_id) AS responsible,
                 COALESCE(sum(m.amount_cents), 0) AS cents, count(m.id) AS count
            FROM public.cash_companies c LEFT JOIN cajas_mes m ON m.company_id = c.id
           WHERE c.account_id = a GROUP BY c.id, c.name, c.responsible_user_id) t), '[]'::jsonb),
      'byMonth', COALESCE((SELECT jsonb_agg(jsonb_build_object('month', to_char(s.m, 'YYYY-MM'),
                  'cents', COALESCE((SELECT sum(amount_cents) FROM elegidos x WHERE x.occurred_on >= s.m AND x.occurred_on < (s.m + interval '1 month')::date), 0))
                  ORDER BY s.m)
          FROM (SELECT (v_last - make_interval(months => g))::date AS m FROM generate_series(0, 11) AS g) AS s), '[]'::jsonb),
      'companies', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
                  'responsible', (SELECT COALESCE(NULLIF(u.full_name, ''), u.email) FROM public.profiles u WHERE u.user_id = c.responsible_user_id))
                  ORDER BY c.name) FROM public.cash_companies c WHERE c.account_id = a), '[]'::jsonb),
      'pending', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'companyId', t.company_id, 'companyName', c.name,
                  'date', t.occurred_on, 'concept', t.concept, 'counterparty', t.counterparty, 'amountCents', t.amount_cents,
                  'rubro', t.rubro, 'projectId', t.project_id, 'projectGeneral', t.project_general)
                  ORDER BY t.occurred_on DESC, t.id)
          FROM (SELECT * FROM del_mes WHERE rubro IS NULL OR (project_id IS NULL AND NOT project_general)
                 ORDER BY occurred_on DESC, id LIMIT 50) t
          JOIN public.cash_companies c ON c.id = t.company_id), '[]'::jsonb)));
END;
$$;

-- ------------------------------------------------------------
-- 9. WhatsApp: cash_as_user (075) pasa proyecto y rubro del borrador
--    Igual que 075; solo cambia la rama 'entry'.
-- ------------------------------------------------------------
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
      -- Por WhatsApp proyecto y rubro son opcionales: sin ellos queda "sin asignar".
      result := to_jsonb(public.cash_company_entry(p_args || jsonb_build_object('action', 'entry', 'source', 'whatsapp')));
    ELSE
      RAISE EXCEPTION 'Consulta no válida' USING ERRCODE = '22023';
  END CASE;
  RETURN result;
END;
$$;

-- ------------------------------------------------------------
-- 10. Permisos
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.cash_panel_access(uuid), public.cash_company_entry(jsonb),
  public.cash_classify_entry(uuid, uuid, boolean, text), public.cash_set_responsible(uuid, uuid),
  public.cash_form_options(uuid), public.cash_access_info(), public.cash_management_panel(date, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_panel_access(uuid), public.cash_company_entry(jsonb),
  public.cash_classify_entry(uuid, uuid, boolean, text), public.cash_set_responsible(uuid, uuid),
  public.cash_form_options(uuid), public.cash_access_info(), public.cash_management_panel(date, uuid)
  TO authenticated;
REVOKE ALL ON FUNCTION public.cash_entry_apply_classification(), public.cash_company_default_responsible()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cash_as_user(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cash_as_user(uuid, text, jsonb) TO service_role;

COMMIT;
