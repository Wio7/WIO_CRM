-- ============================================================
-- 097_gerencia.sql — Base de la app de Gerencia de Golden
--
-- Pedido de Bryce (2026-11-14): app de Gerencia para Golden Habitat, fase 1:
-- tablero (cobranza, caja y ventas de un vistazo, con metas del mes). Esta
-- migración se arma en tres tareas sobre el mismo archivo; aquí va la primera.
--
-- SOLO AGREGA objetos nuevos; no reemplaza ninguna función existente
-- (is_owner_or_gerencia, de la 084, se reutiliza tal cual). Idempotente: se
-- puede volver a correr. Crea:
--   1. gerencia_my_access(): {"rol": "gerencia" | null, "accountId": uuid | null}.
--      rol = 'gerencia' si is_owner_or_gerencia (dueño, super admin o área
--      gerencia); cualquier otro (cobranzas, marketing...) recibe null.
--   2. management_goals: meta del mes (cobranza en céntimos o ventas en
--      unidades), total de la cuenta (project_id NULL) o por proyecto. Con RLS:
--      solo gerencia lee; nadie escribe directo, solo por la RPC.
--   3. gerencia_set_goal(mes, proyecto, tipo, valor): pone, cambia o borra
--      (valor NULL o 0) una meta. El mes se normaliza al primer día.
--   4. gerencia_goals(mes): las metas de ese mes.
--
-- Casos: supabase/tests/097_casos.sql (correr DESPUÉS de aplicar esta; corre
-- como postgres en el SQL Editor y termina en ROLLBACK).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Acceso
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gerencia_my_access()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  RETURN jsonb_build_object(
    'rol', CASE WHEN a IS NOT NULL AND public.is_owner_or_gerencia(a) THEN 'gerencia' ELSE NULL END,
    'accountId', a);
END;
$$;
ALTER FUNCTION public.gerencia_my_access() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gerencia_my_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerencia_my_access() TO authenticated;

-- ------------------------------------------------------------
-- 2. Metas del mes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.management_goals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  month        date NOT NULL CHECK (month = date_trunc('month', month)::date),
  project_id   uuid REFERENCES public.real_estate_projects(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('cobranza', 'ventas')),
  amount_cents bigint CHECK (amount_cents > 0),
  units        integer CHECK (units > 0),
  set_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT management_goals_kind_value CHECK (
    (kind = 'cobranza' AND amount_cents IS NOT NULL AND units IS NULL)
    OR (kind = 'ventas' AND units IS NOT NULL AND amount_cents IS NULL)),
  CONSTRAINT management_goals_unique UNIQUE NULLS NOT DISTINCT (account_id, month, project_id, kind)
);

ALTER TABLE public.management_goals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.management_goals FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.management_goals FROM authenticated;
GRANT SELECT ON public.management_goals TO authenticated;

DROP POLICY IF EXISTS management_goals_select ON public.management_goals;
CREATE POLICY management_goals_select ON public.management_goals FOR SELECT
  USING (public.is_owner_or_gerencia(account_id));

-- ------------------------------------------------------------
-- 3. Poner, cambiar o borrar una meta
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gerencia_set_goal(p_month date, p_project uuid, p_kind text, p_value bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_month date;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT public.is_owner_or_gerencia(a) THEN
    RAISE EXCEPTION 'Solo gerencia' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('cobranza', 'ventas') THEN
    RAISE EXCEPTION 'Tipo de meta no válido' USING ERRCODE = '22023';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'Mes no válido' USING ERRCODE = '22023';
  END IF;
  IF p_value IS NOT NULL AND p_value < 0 THEN
    RAISE EXCEPTION 'Valor no válido' USING ERRCODE = '22023';
  END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.real_estate_projects r WHERE r.id = p_project AND r.account_id = a) THEN
    RAISE EXCEPTION 'Proyecto no válido' USING ERRCODE = '22023';
  END IF;
  v_month := date_trunc('month', p_month)::date;

  IF p_value IS NULL OR p_value = 0 THEN
    DELETE FROM public.management_goals g
     WHERE g.account_id = a AND g.month = v_month AND g.kind = p_kind
       AND g.project_id IS NOT DISTINCT FROM p_project;
    RETURN;
  END IF;

  IF p_kind = 'ventas' AND p_value > 2147483647 THEN
    RAISE EXCEPTION 'Valor no válido' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.management_goals (account_id, month, project_id, kind, amount_cents, units, set_by)
  VALUES (a, v_month, p_project, p_kind,
          CASE WHEN p_kind = 'cobranza' THEN p_value END,
          CASE WHEN p_kind = 'ventas' THEN p_value::integer END,
          auth.uid())
  ON CONFLICT ON CONSTRAINT management_goals_unique DO UPDATE
    SET amount_cents = EXCLUDED.amount_cents, units = EXCLUDED.units,
        set_by = EXCLUDED.set_by, updated_at = now();
END;
$$;
ALTER FUNCTION public.gerencia_set_goal(date, uuid, text, bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gerencia_set_goal(date, uuid, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerencia_set_goal(date, uuid, text, bigint) TO authenticated;

-- ------------------------------------------------------------
-- 4. Metas de un mes
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gerencia_goals(p_month date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT public.is_owner_or_gerencia(a) THEN
    RAISE EXCEPTION 'Solo gerencia' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'projectId', g.project_id,
             'kind', g.kind,
             'value', COALESCE(g.amount_cents, g.units::bigint))
           ORDER BY g.kind, g.project_id NULLS FIRST)
      FROM public.management_goals g
     WHERE g.account_id = a
       AND g.month = date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'America/Lima')::date))::date
  ), '[]'::jsonb);
END;
$$;
ALTER FUNCTION public.gerencia_goals(date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gerencia_goals(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerencia_goals(date) TO authenticated;

-- ------------------------------------------------------------
-- 5. Resumen de cobranza para gerencia
-- Solo PEN; otras monedas se cuentan en otrasMonedas. Cartera = planes
-- activos; el mes cuenta también planes ya pagados (el último pago cierra
-- el plan y no debe sacar ese cobro del mes). Las vistas de saldos filtran
-- por rol con current_user: acá corren como postgres, por eso todo se
-- filtra por la cuenta de quien llama.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gerencia_cobranza(p_month date DEFAULT NULL, p_project uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_today date := (now() AT TIME ZONE 'America/Lima')::date;
  v_month date;
  v_next date;
  v_total bigint; v_vencida bigint; v_planes integer; v_otras integer;
  v_vencia bigint; v_rem bigint; v_cobrado bigint; v_meta bigint;
  v_projects jsonb; v_tramos jsonb; v_morosos jsonb; v_pordia jsonb;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT public.is_owner_or_gerencia(a) THEN
    RAISE EXCEPTION 'Solo gerencia' USING ERRCODE = '42501';
  END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.real_estate_projects r WHERE r.id = p_project AND r.account_id = a) THEN
    RAISE EXCEPTION 'Proyecto no válido' USING ERRCODE = '22023';
  END IF;
  v_month := date_trunc('month', COALESCE(p_month, v_today))::date;
  v_next := (v_month + interval '1 month')::date;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name) ORDER BY r.name, r.id), '[]'::jsonb)
    INTO v_projects
    FROM public.real_estate_projects r WHERE r.account_id = a;

  -- Cartera: planes activos en soles.
  SELECT COALESCE(round(SUM(b.pending_amount) * 100), 0)::bigint,
         COALESCE(round(SUM(b.overdue_amount) * 100), 0)::bigint,
         count(*)::integer
    INTO v_total, v_vencida, v_planes
    FROM public.payment_plan_balances b
    JOIN public.payment_plans p ON p.id = b.plan_id
    LEFT JOIN public.real_estate_units u ON u.id = p.unit_id
   WHERE b.account_id = a AND b.status = 'activo' AND b.currency = 'PEN'
     AND (p_project IS NULL OR u.project_id = p_project);

  SELECT count(*)::integer INTO v_otras
    FROM public.payment_plans p
    LEFT JOIN public.real_estate_units u ON u.id = p.unit_id
   WHERE p.account_id = a AND p.status = 'activo' AND p.currency <> 'PEN'
     AND (p_project IS NULL OR u.project_id = p_project);

  -- Morosos por cliente (contacto) y tramos con la regla de tramoDe.
  WITH od AS (
    SELECT COALESCE(p.contact_id, p.id) AS gkey, p.contact_id, i.due_date, b.remaining,
           u.code AS unit_code, pr.name AS project_name
      FROM public.payment_plans p
      JOIN public.installments i ON i.plan_id = p.id
      JOIN public.installment_balances b ON b.installment_id = i.id
      LEFT JOIN public.real_estate_units u ON u.id = p.unit_id
      LEFT JOIN public.real_estate_projects pr ON pr.id = u.project_id
     WHERE p.account_id = a AND p.status = 'activo' AND p.currency = 'PEN'
       AND i.status = 'pendiente' AND b.remaining > 0 AND i.due_date < v_today
       AND (p_project IS NULL OR u.project_id = p_project)
  ), oldest AS (
    SELECT DISTINCT ON (gkey) gkey, unit_code, project_name
      FROM od ORDER BY gkey, due_date, unit_code
  ), cli AS (
    SELECT od.gkey, (array_agg(od.contact_id))[1] AS contact_id,
           (v_today - MIN(od.due_date)) AS dias,
           round(SUM(od.remaining) * 100)::bigint AS cents
      FROM od GROUP BY od.gkey
  ), cli2 AS (
    SELECT cli.*, o.unit_code, o.project_name,
           CASE WHEN dias <= 30 THEN '1-30' WHEN dias <= 60 THEN '31-60' WHEN dias <= 90 THEN '61-90' ELSE '+90' END AS tramo
      FROM cli JOIN oldest o ON o.gkey = cli.gkey
  )
  SELECT
    (SELECT jsonb_agg(jsonb_build_object('tramo', t.tramo, 'cents', COALESCE(s.cents, 0), 'clientes', COALESCE(s.n, 0)) ORDER BY t.ord)
       FROM (VALUES (1, '1-30'), (2, '31-60'), (3, '61-90'), (4, '+90')) AS t(ord, tramo)
       LEFT JOIN (SELECT cli2.tramo, SUM(cli2.cents)::bigint AS cents, count(*)::integer AS n FROM cli2 GROUP BY cli2.tramo) s ON s.tramo = t.tramo),
    COALESCE((SELECT jsonb_agg(m.j ORDER BY m.dias DESC, m.cents DESC, m.gkey)
       FROM (SELECT cli2.dias, cli2.cents, cli2.gkey,
                    jsonb_build_object(
                      'contactId', cli2.contact_id,
                      'name', c.name,
                      'phone', c.phone,
                      'projectName', cli2.project_name,
                      'unit', cli2.unit_code,
                      'diasAtraso', cli2.dias,
                      'tramo', cli2.tramo,
                      'vencidoCents', cli2.cents,
                      'ultimoPago', (SELECT MAX(ip.paid_on)
                                       FROM public.installment_payments ip
                                       JOIN public.payment_plans pp ON pp.id = ip.plan_id
                                      WHERE ip.account_id = a AND ip.voided_at IS NULL
                                        AND COALESCE(pp.contact_id, pp.id) = cli2.gkey)
                    ) AS j
               FROM cli2 LEFT JOIN public.contacts c ON c.id = cli2.contact_id
              ORDER BY cli2.dias DESC, cli2.cents DESC, cli2.gkey
              LIMIT 20) m), '[]'::jsonb)
  INTO v_tramos, v_morosos;

  -- Lo que vencía en el mes y cuánto de eso ya se cobró.
  SELECT COALESCE(round(SUM(i.amount) * 100), 0)::bigint,
         COALESCE(round(SUM(b.remaining) * 100), 0)::bigint
    INTO v_vencia, v_rem
    FROM public.installments i
    JOIN public.payment_plans p ON p.id = i.plan_id
    JOIN public.installment_balances b ON b.installment_id = i.id
    LEFT JOIN public.real_estate_units u ON u.id = p.unit_id
   WHERE i.account_id = a AND p.currency = 'PEN' AND p.status <> 'cancelado'
     AND i.status <> 'condonada' AND i.due_date >= v_month AND i.due_date < v_next
     AND (p_project IS NULL OR u.project_id = p_project);

  -- Cobrado en el mes (pagos no anulados), total y por día.
  SELECT COALESCE(SUM(d.cents), 0)::bigint,
         COALESCE(jsonb_agg(jsonb_build_object('dia', d.dia, 'cents', d.cents) ORDER BY d.dia), '[]'::jsonb)
    INTO v_cobrado, v_pordia
    FROM (
      SELECT ip.paid_on AS dia, round(SUM(ip.amount) * 100)::bigint AS cents
        FROM public.installment_payments ip
        JOIN public.payment_plans p ON p.id = ip.plan_id
        LEFT JOIN public.real_estate_units u ON u.id = p.unit_id
       WHERE ip.account_id = a AND ip.voided_at IS NULL AND p.currency = 'PEN' AND p.status <> 'cancelado'
         AND ip.paid_on >= v_month AND ip.paid_on < v_next
         AND (p_project IS NULL OR u.project_id = p_project)
       GROUP BY ip.paid_on
    ) d;

  SELECT g.amount_cents INTO v_meta
    FROM public.management_goals g
   WHERE g.account_id = a AND g.month = v_month AND g.kind = 'cobranza'
     AND g.project_id IS NOT DISTINCT FROM p_project;

  RETURN jsonb_build_object(
    'month', v_month,
    'projectId', p_project,
    'projects', v_projects,
    'cartera', jsonb_build_object('totalCents', v_total, 'vigenteCents', v_total - v_vencida,
                                  'vencidaCents', v_vencida, 'planes', v_planes),
    'tramos', v_tramos,
    'mes', jsonb_build_object(
      'venciaCents', v_vencia,
      'cobradoDeLoQueVenciaCents', v_vencia - v_rem,
      'cobradoTotalCents', v_cobrado,
      'recaudacionPct', CASE WHEN v_vencia > 0 THEN round(100.0 * (v_vencia - v_rem) / v_vencia, 1) END,
      'metaCents', v_meta,
      'cumplimientoPct', CASE WHEN v_meta > 0 THEN round(100.0 * v_cobrado / v_meta, 1) END),
    'porDia', v_pordia,
    'morosos', v_morosos,
    'otrasMonedas', v_otras);
END;
$$;
ALTER FUNCTION public.gerencia_cobranza(date, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gerencia_cobranza(date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerencia_cobranza(date, uuid) TO authenticated;

-- ------------------------------------------------------------
-- 6. Portada de gerencia: cifras del mes, alertas y áreas
-- Cobrado, cartera y morosidad salen de gerencia_cobranza (una sola regla:
-- el mes cuenta planes no cancelados, la cartera solo planes activos); aquí
-- no se vuelve a calcular. Gasto de caja = todas las cajas de la cuenta, sin
-- reversiones ni traspasos entre cajas (mismo criterio que la 094). Leads y
-- separaciones por día de Lima; la separación rechazada no cuenta.
-- Alertas, en este orden y solo las que aplican: cartera90 (rojo),
-- meta_cobranza (rojo, solo mes actual), banco, traspasos, caja (ámbar).
-- Áreas, siempre 5: cobranzas (vouchers por revisar + traspasos recibidos),
-- legal y postventa (traspasos recibidos), administracion (movimientos por
-- conciliar), marketing (piezas en revisión). masAntiguoDias: desde el
-- registro pendiente más antiguo (día de Lima); null si no hay pendientes o
-- si no hay fecha (los vouchers no la tienen).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gerencia_resumen(p_month date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_today date := (now() AT TIME ZONE 'America/Lima')::date;
  v_month date; v_prev date; v_next date; v_dias integer;
  v_cur jsonb; v_pre jsonb;
  v_cobrado bigint; v_cobrado_prev bigint; v_meta bigint;
  v_total bigint; v_vencida bigint; v_c90 bigint; v_c90_clientes integer;
  v_gasto bigint; v_gasto_prev bigint;
  v_leads integer; v_leads_prev integer; v_sep integer; v_sep_prev integer; v_meta_ventas integer;
  v_vouchers integer;
  v_h_cob integer; v_h_cob_old date; v_h_leg integer; v_h_leg_old date; v_h_pos integer; v_h_pos_old date;
  v_h_viejos integer;
  v_b_pend integer; v_b_old date; v_b_viejos integer;
  v_m_pend integer; v_m_old date;
  v_morosidad numeric;
  v_alertas jsonb := '[]'::jsonb;
  v_areas jsonb;
  v_pend_total integer;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT public.is_owner_or_gerencia(a) THEN
    RAISE EXCEPTION 'Solo gerencia' USING ERRCODE = '42501';
  END IF;
  v_month := date_trunc('month', COALESCE(p_month, v_today))::date;
  v_prev := (v_month - interval '1 month')::date;
  v_next := (v_month + interval '1 month')::date;
  v_dias := v_next - v_month;

  -- Cobranza (mismo criterio que gerencia_cobranza).
  v_cur := public.gerencia_cobranza(v_month, NULL);
  v_pre := public.gerencia_cobranza(v_prev, NULL);
  v_cobrado := (v_cur #>> '{mes,cobradoTotalCents}')::bigint;
  v_cobrado_prev := (v_pre #>> '{mes,cobradoTotalCents}')::bigint;
  v_meta := (v_cur #>> '{mes,metaCents}')::bigint;
  v_total := (v_cur #>> '{cartera,totalCents}')::bigint;
  v_vencida := (v_cur #>> '{cartera,vencidaCents}')::bigint;
  v_morosidad := CASE WHEN v_total > 0 THEN round(100.0 * v_vencida / v_total, 1) END;
  SELECT (t->>'cents')::bigint, (t->>'clientes')::integer
    INTO v_c90, v_c90_clientes
    FROM jsonb_array_elements(v_cur->'tramos') t WHERE t->>'tramo' = '+90';
  v_c90 := COALESCE(v_c90, 0);
  v_c90_clientes := COALESCE(v_c90_clientes, 0);

  -- Gasto de caja: todas las cajas de la cuenta, sin reversiones ni traspasos.
  SELECT COALESCE(SUM(e.amount_cents) FILTER (WHERE e.occurred_on >= v_month AND e.occurred_on < v_next), 0)::bigint,
         COALESCE(SUM(e.amount_cents) FILTER (WHERE e.occurred_on >= v_prev AND e.occurred_on < v_month), 0)::bigint
    INTO v_gasto, v_gasto_prev
    FROM public.cash_entries e
   WHERE e.account_id = a AND e.kind = 'expense' AND e.reversal_of IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.cash_entries x WHERE x.reversal_of = e.id)
     AND to_jsonb(e)->>'transfer_id' IS NULL
     AND e.occurred_on >= v_prev AND e.occurred_on < v_next;

  -- Leads y separaciones (día de Lima).
  SELECT count(*) FILTER (WHERE (c.created_at AT TIME ZONE 'America/Lima')::date >= v_month
                            AND (c.created_at AT TIME ZONE 'America/Lima')::date < v_next)::integer,
         count(*) FILTER (WHERE (c.created_at AT TIME ZONE 'America/Lima')::date >= v_prev
                            AND (c.created_at AT TIME ZONE 'America/Lima')::date < v_month)::integer
    INTO v_leads, v_leads_prev
    FROM public.contacts c WHERE c.account_id = a;
  SELECT count(*) FILTER (WHERE (r.created_at AT TIME ZONE 'America/Lima')::date >= v_month
                            AND (r.created_at AT TIME ZONE 'America/Lima')::date < v_next)::integer,
         count(*) FILTER (WHERE (r.created_at AT TIME ZONE 'America/Lima')::date >= v_prev
                            AND (r.created_at AT TIME ZONE 'America/Lima')::date < v_month)::integer
    INTO v_sep, v_sep_prev
    FROM public.reservations r WHERE r.account_id = a AND r.status <> 'rechazada';
  SELECT g.units INTO v_meta_ventas
    FROM public.management_goals g
   WHERE g.account_id = a AND g.month = v_month AND g.kind = 'ventas' AND g.project_id IS NULL;

  -- Áreas.
  SELECT count(*)::integer INTO v_vouchers
    FROM public.installments i WHERE i.account_id = a AND i.status = 'pendiente' AND i.voucher_path IS NOT NULL;
  SELECT count(*) FILTER (WHERE h.to_module = 'cobranzas')::integer,
         MIN((h.created_at AT TIME ZONE 'America/Lima')::date) FILTER (WHERE h.to_module = 'cobranzas'),
         count(*) FILTER (WHERE h.to_module = 'legal')::integer,
         MIN((h.created_at AT TIME ZONE 'America/Lima')::date) FILTER (WHERE h.to_module = 'legal'),
         count(*) FILTER (WHERE h.to_module = 'postventa')::integer,
         MIN((h.created_at AT TIME ZONE 'America/Lima')::date) FILTER (WHERE h.to_module = 'postventa'),
         count(*) FILTER (WHERE (h.created_at AT TIME ZONE 'America/Lima')::date < v_today - 3)::integer
    INTO v_h_cob, v_h_cob_old, v_h_leg, v_h_leg_old, v_h_pos, v_h_pos_old, v_h_viejos
    FROM public.module_handoffs h WHERE h.account_id = a AND h.status = 'pendiente';
  SELECT count(*) FILTER (WHERE m.estado = 'por_conciliar')::integer,
         MIN(m.fecha) FILTER (WHERE m.estado = 'por_conciliar'),
         count(*) FILTER (WHERE m.estado IN ('por_conciliar', 'revisar') AND m.fecha < v_today - 7)::integer
    INTO v_b_pend, v_b_old, v_b_viejos
    FROM public.bank_statement_movements m WHERE m.account_id = a;
  SELECT count(*)::integer, MIN((p.updated_at AT TIME ZONE 'America/Lima')::date)
    INTO v_m_pend, v_m_old
    FROM public.marketing_pieces p WHERE p.account_id = a AND p.status = 'en_revision';

  v_areas := jsonb_build_array(
    jsonb_build_object('area', 'cobranzas', 'pendientes', v_vouchers + v_h_cob, 'masAntiguoDias', v_today - v_h_cob_old),
    jsonb_build_object('area', 'legal', 'pendientes', v_h_leg, 'masAntiguoDias', v_today - v_h_leg_old),
    jsonb_build_object('area', 'postventa', 'pendientes', v_h_pos, 'masAntiguoDias', v_today - v_h_pos_old),
    jsonb_build_object('area', 'administracion', 'pendientes', v_b_pend, 'masAntiguoDias', v_today - v_b_old),
    jsonb_build_object('area', 'marketing', 'pendientes', v_m_pend, 'masAntiguoDias', v_today - v_m_old));
  v_pend_total := v_vouchers + v_h_cob + v_h_leg + v_h_pos + v_b_pend + v_m_pend;

  -- Alertas (orden fijo).
  IF v_c90 > 0 THEN
    v_alertas := v_alertas || jsonb_build_array(jsonb_build_object(
      'clave', 'cartera90', 'nivel', 'rojo', 'titulo', 'Cartera con más de 90 días',
      'detalle', 'S/ ' || to_char(v_c90 / 100.0, 'FM999,999,999,990.00') || ' en ' || v_c90_clientes || ' clientes',
      'ruta', '/cobranza?tramo=%2B90'));
  END IF;
  IF v_meta IS NOT NULL AND v_month = date_trunc('month', v_today)::date
     AND v_cobrado::numeric / v_meta < (extract(day FROM v_today)::numeric / v_dias) - 0.10 THEN
    v_alertas := v_alertas || jsonb_build_array(jsonb_build_object(
      'clave', 'meta_cobranza', 'nivel', 'rojo', 'titulo', 'Cobranza por debajo de la meta',
      'detalle', 'Lleva ' || round(100.0 * v_cobrado / v_meta) || ' % de la meta y el mes va en el día ' ||
                 extract(day FROM v_today)::integer || ' de ' || v_dias,
      'ruta', '/cobranza'));
  END IF;
  IF v_b_viejos > 0 THEN
    v_alertas := v_alertas || jsonb_build_array(jsonb_build_object(
      'clave', 'banco', 'nivel', 'ambar', 'titulo', 'Movimientos del banco sin conciliar',
      'detalle', v_b_viejos || ' con más de 7 días', 'ruta', '/areas'));
  END IF;
  IF v_h_viejos > 0 THEN
    v_alertas := v_alertas || jsonb_build_array(jsonb_build_object(
      'clave', 'traspasos', 'nivel', 'ambar', 'titulo', 'Traspasos sin atender',
      'detalle', v_h_viejos || ' con más de 3 días', 'ruta', '/areas'));
  END IF;
  IF v_gasto_prev > 0 AND v_gasto > v_gasto_prev * 1.2 THEN
    v_alertas := v_alertas || jsonb_build_array(jsonb_build_object(
      'clave', 'caja', 'nivel', 'ambar', 'titulo', 'Gasto de caja sobre el mes anterior',
      'detalle', 'S/ ' || to_char(v_gasto / 100.0, 'FM999,999,999,990.00') || ' contra S/ ' ||
                 to_char(v_gasto_prev / 100.0, 'FM999,999,999,990.00') || ' del mes anterior',
      'ruta', '/caja'));
  END IF;

  RETURN jsonb_build_object(
    'month', v_month,
    'kpis', jsonb_build_object(
      'cobrado', jsonb_build_object('cents', v_cobrado, 'prevCents', v_cobrado_prev, 'metaCents', v_meta),
      'morosidadPct', v_morosidad,
      'cartera90Cents', v_c90,
      'cajaGasto', jsonb_build_object('cents', v_gasto, 'prevCents', v_gasto_prev),
      'leads', jsonb_build_object('count', v_leads, 'prevCount', v_leads_prev),
      'separaciones', jsonb_build_object('count', v_sep, 'prevCount', v_sep_prev, 'metaUnits', v_meta_ventas),
      'pendientesAreas', v_pend_total),
    'alertas', v_alertas,
    'areas', v_areas);
END;
$$;
ALTER FUNCTION public.gerencia_resumen(date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gerencia_resumen(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerencia_resumen(date) TO authenticated;
