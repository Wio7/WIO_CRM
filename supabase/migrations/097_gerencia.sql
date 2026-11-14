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
