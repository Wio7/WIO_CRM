-- ============================================================
-- 094_caja_chica_por_area.sql — Caja chica: contabilidad y administración solo
-- ven la caja principal de la cuenta
--
-- Pedido de Bryce (2026-11-13): las cuentas de Administración (y Contabilidad)
-- solo ven la caja "Golden Habitat". Las cajas de los otros negocios del dueño
-- (La Jato, Cafetería, Restaurante, Efectivo 1...) no tienen por qué verlas.
-- Dueño y gerencia siguen viendo todas.
--
-- Casos: supabase/tests/094_casos.sql (correr DESPUÉS de aplicar esta).
--
-- Qué cambia:
--   1. Nueva public.cash_panel_companies(cuenta): las cajas que el panel de
--      gerencia muestra a quien lo abre. Dueño o gerencia: todas las de la
--      cuenta. Los demás con acceso al panel (contabilidad, administración):
--      solo la caja principal, la que tiene el mismo id que la cuenta (la
--      creó la migración 065 a partir de la caja original), más las cajas
--      de las que sean dueños.
--   2. cash_management_panel (vigente = 087): filtra gastos, la lista de
--      cajas y el desglose por caja con cash_panel_companies. Pedir otra caja
--      da "Caja no válida".
--   3. cash_classify_entry (vigente = 087): quien clasifica por tener acceso
--      al panel solo puede hacerlo en esas cajas.
--
-- ANTES de aplicar, comprobar que las funciones vivas son las del repo:
--   SELECT p.proname, md5(p.prosrc) FROM pg_proc p
--    WHERE p.proname IN ('cash_management_panel', 'cash_classify_entry')
--      AND p.pronamespace = 'public'::regnamespace;
--   Deben salir (la 087 del repo; con saltos de línea de Windows si se pegó
--   desde un archivo con CRLF, que es lo que hay en wioCRM, visto 2026-11-13):
--     cash_management_panel  50c532aa2eefebf4258fceeddafcd6b7  (CRLF: 85e7a0edde8c5a8b2ab94817d7621088)
--     cash_classify_entry    ca966f29cb027b63f75a240b073fd429  (CRLF: a23c1d195fa6fee00fb1de9aaf472092)
--   Si no coinciden, NO aplicar: la base real se desvía del repo.
--
-- Idempotente — se puede volver a correr.
-- ============================================================
BEGIN;

-- 1. Cajas visibles en el panel
CREATE OR REPLACE FUNCTION public.cash_panel_companies(p_account uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id FROM public.cash_companies c
   WHERE c.account_id = p_account
     AND (public.is_owner_or_gerencia(p_account)
          OR c.id = p_account
          OR public.cash_company_role(c.id) = 'owner');
$$;
ALTER FUNCTION public.cash_panel_companies(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cash_panel_companies(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_panel_companies(uuid) TO authenticated;

-- 2. Panel de gerencia (copia de la 087 con el filtro de cajas)
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
  IF p_company IS NOT NULL AND p_company NOT IN (SELECT public.cash_panel_companies(a)) THEN
    RAISE EXCEPTION 'Caja no válida' USING ERRCODE = '22023'; END IF;

  RETURN (
    WITH todos AS (
      SELECT e.id, e.company_id, e.amount_cents, e.occurred_on, e.project_id, e.project_general, e.rubro,
             e.concept, e.counterparty
        FROM public.cash_entries e
       WHERE e.account_id = a AND e.company_id IN (SELECT public.cash_panel_companies(a))
         AND e.kind = 'expense' AND e.reversal_of IS NULL
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
           WHERE c.account_id = a AND c.id IN (SELECT public.cash_panel_companies(a)) GROUP BY c.id, c.name, c.responsible_user_id) t), '[]'::jsonb),
      'byMonth', COALESCE((SELECT jsonb_agg(jsonb_build_object('month', to_char(s.m, 'YYYY-MM'),
                  'cents', COALESCE((SELECT sum(amount_cents) FROM elegidos x WHERE x.occurred_on >= s.m AND x.occurred_on < (s.m + interval '1 month')::date), 0))
                  ORDER BY s.m)
          FROM (SELECT (v_last - make_interval(months => g))::date AS m FROM generate_series(0, 11) AS g) AS s), '[]'::jsonb),
      'companies', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
                  'responsible', (SELECT COALESCE(NULLIF(u.full_name, ''), u.email) FROM public.profiles u WHERE u.user_id = c.responsible_user_id))
                  ORDER BY c.name) FROM public.cash_companies c WHERE c.account_id = a AND c.id IN (SELECT public.cash_panel_companies(a))), '[]'::jsonb),
      'projects', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) ORDER BY p.name)
                  FROM public.real_estate_projects p WHERE p.account_id = a), '[]'::jsonb),
      'pending', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'companyId', t.company_id, 'companyName', c.name,
                  'date', t.occurred_on, 'concept', t.concept, 'counterparty', t.counterparty, 'amountCents', t.amount_cents,
                  'rubro', t.rubro, 'projectId', t.project_id, 'projectGeneral', t.project_general)
                  ORDER BY t.occurred_on DESC, t.id)
          FROM (SELECT * FROM del_mes WHERE rubro IS NULL OR (project_id IS NULL AND NOT project_general)
                 ORDER BY occurred_on DESC, id LIMIT 50) t
          JOIN public.cash_companies c ON c.id = t.company_id), '[]'::jsonb)));
END;
$$;

-- 3. Clasificar un gasto (copia de la 087 con el filtro de cajas)
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
  IF NOT ((COALESCE(public.cash_panel_access(e.account_id), false)
               AND e.company_id IN (SELECT public.cash_panel_companies(e.account_id)))
          OR r = 'owner'
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

COMMIT;
