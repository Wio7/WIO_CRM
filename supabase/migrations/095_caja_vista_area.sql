-- ============================================================
-- 095_caja_vista_area.sql — Caja chica completa, de solo lectura, para las
-- áreas con acceso al panel (Administración y Contabilidad)
--
-- Pedido de Bryce (2026-11-13): en la app de Administración, la caja chica
-- tiene que verse como en Golden Caja (saldo, ingresos, gastos, movimientos),
-- no solo el desglose de gastos. Golden Caja arma su pantalla con
-- cash_company_snapshot, que solo entrega datos a dueños y cajeros de la caja;
-- Administración no lo es. Esta función nueva entrega la misma información
-- en modo lectura, y solo de las cajas que cash_panel_companies (094) permite:
-- para Administración y Contabilidad, la caja principal (Golden Habitat).
--
-- No reemplaza ninguna función existente. Requiere 087 (cash_panel_access)
-- y 094 (cash_panel_companies).
--
-- Casos: supabase/tests/095_casos.sql (correr DESPUÉS de aplicar esta).
-- Idempotente — se puede volver a correr.
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.cash_area_snapshot(p_company uuid DEFAULT NULL, p_month date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  c uuid;
  v_name text;
  v_from date := CASE WHEN p_month IS NULL THEN NULL ELSE date_trunc('month', p_month)::date END;
  v_to date := CASE WHEN p_month IS NULL THEN NULL ELSE (date_trunc('month', p_month) + interval '1 month')::date END;
  v_mes date := date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'America/Lima')::date))::date;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT public.cash_panel_access(a) THEN
    RAISE EXCEPTION 'Sin acceso a la caja' USING ERRCODE = '42501'; END IF;
  c := COALESCE(p_company, a);
  IF c NOT IN (SELECT public.cash_panel_companies(a)) THEN
    RAISE EXCEPTION 'Caja no válida' USING ERRCODE = '22023'; END IF;
  SELECT name INTO v_name FROM public.cash_companies WHERE id = c AND account_id = a;

  RETURN (
    -- Montos con signo, igual que cash_company_snapshot (065): una anulación
    -- resta de la columna del movimiento que anula.
    WITH mov AS (
      SELECT e.*,
             CASE WHEN (e.kind = 'income' AND e.reversal_of IS NULL) OR (e.kind = 'expense' AND e.reversal_of IS NOT NULL)
                  THEN CASE WHEN e.reversal_of IS NULL THEN e.amount_cents ELSE -e.amount_cents END ELSE 0 END AS ingreso,
             CASE WHEN (e.kind = 'expense' AND e.reversal_of IS NULL) OR (e.kind = 'income' AND e.reversal_of IS NOT NULL)
                  THEN CASE WHEN e.reversal_of IS NULL THEN e.amount_cents ELSE -e.amount_cents END ELSE 0 END AS egreso
        FROM public.cash_entries e
       WHERE e.account_id = a AND e.company_id = c),
    del_mes AS (SELECT * FROM mov WHERE occurred_on >= v_mes AND occurred_on < (v_mes + interval '1 month')::date)
    SELECT jsonb_build_object(
      'companyId', c,
      'companyName', v_name,
      'month', to_char(v_mes, 'YYYY-MM'),
      'companies', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name) ORDER BY x.name)
          FROM public.cash_companies x WHERE x.account_id = a AND x.id IN (SELECT public.cash_panel_companies(a))), '[]'::jsonb),
      'incomeCents', COALESCE((SELECT sum(ingreso) FROM mov), 0),
      'expenseCents', COALESCE((SELECT sum(egreso) FROM mov), 0),
      'monthIncomeCents', COALESCE((SELECT sum(ingreso) FROM del_mes), 0),
      'monthExpenseCents', COALESCE((SELECT sum(egreso) FROM del_mes), 0),
      'monthCount', (SELECT count(*) FROM del_mes WHERE reversal_of IS NULL),
      'entryCount', (SELECT count(*) FROM mov WHERE reversal_of IS NULL),
      'byMonth', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'month', to_char(s.m, 'YYYY-MM'),
            'incomeCents', COALESCE((SELECT sum(ingreso) FROM mov WHERE occurred_on >= s.m AND occurred_on < (s.m + interval '1 month')::date), 0),
            'expenseCents', COALESCE((SELECT sum(egreso) FROM mov WHERE occurred_on >= s.m AND occurred_on < (s.m + interval '1 month')::date), 0))
            ORDER BY s.m)
          FROM (SELECT (v_mes - make_interval(months => g))::date AS m FROM generate_series(0, 11) AS g) s), '[]'::jsonb),
      -- Movimientos (sin las filas de anulación; cada uno dice si fue anulado).
      -- Con p_month: los de ese mes; sin p_month: los 300 más recientes.
      'entries', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', t.id, 'kind', t.kind, 'amountCents', t.amount_cents, 'concept', t.concept,
            'counterparty', t.counterparty, 'date', t.occurred_on, 'createdAt', t.created_at,
            'actorName', t.actor_name, 'rubro', t.rubro, 'projectId', t.project_id,
            'projectGeneral', t.project_general, 'projectName', p.name,
            'paymentMethod', to_jsonb(t)->>'payment_method',
            'justification', to_jsonb(t)->>'justification',
            'transfer', (to_jsonb(t)->>'transfer_id') IS NOT NULL,
            'reversed', EXISTS (SELECT 1 FROM public.cash_entries x WHERE x.reversal_of = t.id))
            ORDER BY t.occurred_on DESC, t.created_at DESC, t.id DESC)
          FROM (SELECT * FROM mov
                 WHERE reversal_of IS NULL AND (v_from IS NULL OR (occurred_on >= v_from AND occurred_on < v_to))
                 ORDER BY occurred_on DESC, created_at DESC, id DESC
                 LIMIT CASE WHEN v_from IS NULL THEN 300 ELSE 1000 END) t
          LEFT JOIN public.real_estate_projects p ON p.id = t.project_id), '[]'::jsonb)
    ));
END;
$$;
ALTER FUNCTION public.cash_area_snapshot(uuid, date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cash_area_snapshot(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_area_snapshot(uuid, date) TO authenticated;

COMMIT;
