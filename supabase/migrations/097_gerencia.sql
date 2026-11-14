-- ============================================================
-- 097_gerencia.sql — Base de la app de Gerencia de Golden
--
-- Pedido de Bryce (2026-11-14): app de Gerencia para Golden Habitat, fase 1:
-- tablero (cobranza, caja y ventas de un vistazo, con metas del mes). Esta
-- migración se arma en tres tareas sobre el mismo archivo.
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
--   5. _gerencia_cartera y _gerencia_cobrado_mes: ayudantes internos (sin permiso
--      para authenticated) que comparten gerencia_cobranza y gerencia_resumen.
--   6. gerencia_cobranza(mes, proyecto, tramo, busqueda, limite, desde): cartera,
--      tramos, morosos y cobrado del mes. Firma definitiva (no cambiarla sin DROP).
--   7. gerencia_resumen(mes): portada con cifras, alertas estructuradas y 5 áreas.
--
-- Notas de contrato (para la app de Gerencia):
--   - "ventas" en management_goals = separaciones del ERP por ahora (la venta
--     real vendrá del catálogo en la fase 3).
--   - leads = contactos creados en el mes (misma definición que marketing_summary, 096).
--   - Los tramos usan la etiqueta "+90"; la app la mapea al "90+" de collections.ts.
--   - Dinero en céntimos bigint; fechas y meses en hora de Lima; "version": 1 en
--     el JSON de gerencia_cobranza y gerencia_resumen.
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
  month        date NOT NULL CHECK (month = date_trunc('month', month::timestamp)::date),
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
  v_month := date_trunc('month', p_month::timestamp)::date;

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
       AND g.month = date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'America/Lima')::date)::timestamp)::date
  ), '[]'::jsonb);
END;
$$;
ALTER FUNCTION public.gerencia_goals(date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gerencia_goals(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerencia_goals(date) TO authenticated;

-- ------------------------------------------------------------
-- 5. Ayudantes internos de cobranza (SIN permiso para authenticated: solo
--    los llaman gerencia_cobranza y gerencia_resumen, que ya validaron la
--    cuenta). Corren como postgres: las vistas de saldos filtran por rol con
--    current_user, así que todo se filtra a mano por la cuenta.
-- ------------------------------------------------------------

-- Cartera de hoy (foto): planes activos en soles. Una sola base, la cuota
-- pendiente con saldo, para total, vencida y tramos; así la suma de los
-- tramos es igual a vencidaCents. El tramo se mide por los días de atraso de
-- CADA cuota (misma regla de cortes que tramoDe de src/lib/collections.ts,
-- que se mide por cliente; aquí por cuota para que los montos cuadren).
-- nuevos90 = clientes cuya cuota vencida más antigua cruzó p_nuevo_desde en
-- la ventana (atraso entre p_nuevo_desde+1 y p_nuevo_hasta) y lo que deben.
CREATE OR REPLACE FUNCTION public._gerencia_cartera(
  p_account uuid, p_project uuid DEFAULT NULL,
  p_nuevo_desde integer DEFAULT 90, p_nuevo_hasta integer DEFAULT 120)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Lima')::date;
  v_total bigint; v_vencida bigint; v_planes integer; v_otras integer;
  v_tramos jsonb; v_n90 integer; v_c90 bigint;
BEGIN
  SELECT count(*)::integer INTO v_planes
    FROM public.payment_plans p
    LEFT JOIN public.real_estate_units u ON u.id = p.unit_id
   WHERE p.account_id = p_account AND p.status = 'activo' AND p.currency = 'PEN'
     AND (p_project IS NULL OR u.project_id = p_project);
  SELECT count(*)::integer INTO v_otras
    FROM public.payment_plans p
    LEFT JOIN public.real_estate_units u ON u.id = p.unit_id
   WHERE p.account_id = p_account AND p.status = 'activo' AND p.currency <> 'PEN'
     AND (p_project IS NULL OR u.project_id = p_project);

  WITH base AS (
    SELECT COALESCE(p.contact_id, p.id) AS gkey, i.due_date, b.remaining
      FROM public.payment_plans p
      JOIN public.installments i ON i.plan_id = p.id
      JOIN public.installment_balances b ON b.installment_id = i.id
      LEFT JOIN public.real_estate_units u ON u.id = p.unit_id
     WHERE p.account_id = p_account AND p.status = 'activo' AND p.currency = 'PEN'
       AND i.status = 'pendiente'
       AND (p_project IS NULL OR u.project_id = p_project)
  ), d AS (
    SELECT gkey, (v_today - due_date) AS dias, remaining FROM base WHERE due_date < v_today AND remaining > 0
  ), tr AS (
    SELECT CASE WHEN dias <= 30 THEN '1-30' WHEN dias <= 60 THEN '31-60' WHEN dias <= 90 THEN '61-90' ELSE '+90' END AS tramo,
           SUM(remaining) AS s, count(DISTINCT gkey) AS n
      FROM d GROUP BY 1
  ), cl AS (
    SELECT gkey, MAX(dias) AS md, SUM(remaining) AS s FROM d GROUP BY gkey
  )
  SELECT COALESCE(round((SELECT SUM(remaining) FROM base) * 100), 0)::bigint,
         COALESCE(round((SELECT SUM(remaining) FROM d) * 100), 0)::bigint,
         (SELECT jsonb_agg(jsonb_build_object('tramo', t.tramo, 'cents', COALESCE(round(tr.s * 100), 0)::bigint,
                                              'clientes', COALESCE(tr.n, 0)::integer) ORDER BY t.ord)
            FROM (VALUES (1, '1-30'), (2, '31-60'), (3, '61-90'), (4, '+90')) AS t(ord, tramo)
            LEFT JOIN tr ON tr.tramo = t.tramo),
         (SELECT count(*)::integer FROM cl WHERE cl.md > p_nuevo_desde AND cl.md <= p_nuevo_hasta),
         COALESCE((SELECT round(SUM(cl.s) * 100) FROM cl WHERE cl.md > p_nuevo_desde AND cl.md <= p_nuevo_hasta), 0)::bigint
    INTO v_total, v_vencida, v_tramos, v_n90, v_c90;

  RETURN jsonb_build_object(
    'totalCents', v_total, 'vigenteCents', v_total - v_vencida, 'vencidaCents', v_vencida,
    'planes', v_planes, 'otrasMonedas', v_otras, 'tramos', v_tramos,
    'nuevos90', jsonb_build_object('clientes', v_n90, 'cents', v_c90));
END;
$$;
ALTER FUNCTION public._gerencia_cartera(uuid, uuid, integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._gerencia_cartera(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;

-- Cobrado en un mes (céntimos): pagos no anulados de planes no cancelados en
-- soles, por fecha de pago.
CREATE OR REPLACE FUNCTION public._gerencia_cobrado_mes(p_account uuid, p_month date, p_project uuid DEFAULT NULL)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(round(SUM(ip.amount) * 100), 0)::bigint
    FROM public.installment_payments ip
    JOIN public.payment_plans p ON p.id = ip.plan_id
    LEFT JOIN public.real_estate_units u ON u.id = p.unit_id
   WHERE ip.account_id = p_account AND ip.voided_at IS NULL AND p.currency = 'PEN' AND p.status <> 'cancelado'
     AND ip.paid_on >= date_trunc('month', p_month::timestamp)::date
     AND ip.paid_on < (date_trunc('month', p_month::timestamp) + interval '1 month')::date
     AND (p_project IS NULL OR u.project_id = p_project);
$$;
ALTER FUNCTION public._gerencia_cobrado_mes(uuid, date, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._gerencia_cobrado_mes(uuid, date, uuid) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 6. Resumen de cobranza para gerencia
-- Solo PEN; otras monedas se cuentan en otrasMonedas.
-- Dos tiempos distintos en el mismo JSON ("asOf" = hoy en Lima):
--   - cartera, tramos y morosos son la FOTO DE HOY (planes activos), aunque
--     se pida otro mes;
--   - el bloque "mes" es HISTÓRICO: cobradoTotalCents y porDia cuentan pagos
--     por fecha de pago; cobradoDeLoQueVenciaCents cuenta los pagos hechos
--     hasta el último día del mes a las cuotas que vencían en él, más las
--     cuotas de ese mes cubiertas por un abono (adelantada). El mes cuenta
--     también planes ya pagados (el último pago cierra el plan).
-- Filtros p_tramo, p_search, p_limit, p_offset: solo afectan a "morosos"
-- (morososTotal = cuántos cumplen, antes de limit/offset). p_tramo usa las
-- etiquetas '1-30', '31-60', '61-90', '+90' (la app mapea '+90' al '90+' de
-- collections.ts). Tramos: por cuota (ver _gerencia_cartera); un moroso
-- (cliente) va en el tramo de su cuota vencida más antigua.
-- version = 1 es el contrato del JSON (cámbiese al romper la forma).
-- ------------------------------------------------------------
-- Definición de 2 parámetros de esta misma migración (aún no en producción):
-- se quita para no dejar dos sobrecargas.
DROP FUNCTION IF EXISTS public.gerencia_cobranza(date, uuid);
CREATE OR REPLACE FUNCTION public.gerencia_cobranza(
  p_month date DEFAULT NULL, p_project uuid DEFAULT NULL, p_tramo text DEFAULT NULL,
  p_search text DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_today date := (now() AT TIME ZONE 'America/Lima')::date;
  v_month date;
  v_next date;
  v_cartera jsonb;
  v_vencia bigint; v_cobrado_vencia bigint; v_cobrado bigint; v_meta bigint;
  v_projects jsonb; v_morosos jsonb; v_morosos_total integer; v_pordia jsonb;
  v_pat text;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT public.is_owner_or_gerencia(a) THEN
    RAISE EXCEPTION 'Solo gerencia' USING ERRCODE = '42501';
  END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.real_estate_projects r WHERE r.id = p_project AND r.account_id = a) THEN
    RAISE EXCEPTION 'Proyecto no válido' USING ERRCODE = '22023';
  END IF;
  IF p_tramo IS NOT NULL AND p_tramo NOT IN ('1-30', '31-60', '61-90', '+90') THEN
    RAISE EXCEPTION 'Tramo no válido' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'Paginación no válida' USING ERRCODE = '22023';
  END IF;
  v_month := date_trunc('month', COALESCE(p_month, v_today)::timestamp)::date;
  v_next := (v_month + interval '1 month')::date;
  IF p_search IS NOT NULL AND btrim(p_search) <> '' THEN
    v_pat := '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name) ORDER BY r.name, r.id), '[]'::jsonb)
    INTO v_projects
    FROM public.real_estate_projects r WHERE r.account_id = a;

  v_cartera := public._gerencia_cartera(a, p_project);

  -- Morosos por cliente (contacto), con la cuota vencida más antigua como referencia.
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
    SELECT cli.*, o.unit_code, o.project_name, c.name AS cname, c.phone AS cphone,
           CASE WHEN dias <= 30 THEN '1-30' WHEN dias <= 60 THEN '31-60' WHEN dias <= 90 THEN '61-90' ELSE '+90' END AS tramo
      FROM cli JOIN oldest o ON o.gkey = cli.gkey
      LEFT JOIN public.contacts c ON c.id = cli.contact_id
  ), f AS (
    SELECT * FROM cli2
     WHERE (p_tramo IS NULL OR cli2.tramo = p_tramo)
       AND (v_pat IS NULL OR cli2.cname ILIKE v_pat OR cli2.cphone ILIKE v_pat)
  )
  SELECT (SELECT count(*)::integer FROM f),
    COALESCE((SELECT jsonb_agg(m.j ORDER BY m.dias DESC, m.cents DESC, m.gkey)
       FROM (SELECT f.dias, f.cents, f.gkey,
                    jsonb_build_object(
                      'contactId', f.contact_id,
                      'name', f.cname,
                      'phone', f.cphone,
                      'projectName', f.project_name,
                      'unit', f.unit_code,
                      'diasAtraso', f.dias,
                      'tramo', f.tramo,
                      'vencidoCents', f.cents,
                      'ultimoPago', (SELECT MAX(ip.paid_on)
                                       FROM public.installment_payments ip
                                       JOIN public.payment_plans pp ON pp.id = ip.plan_id
                                      WHERE ip.account_id = a AND ip.voided_at IS NULL
                                        AND COALESCE(pp.contact_id, pp.id) = f.gkey)
                    ) AS j
               FROM f
              ORDER BY f.dias DESC, f.cents DESC, f.gkey
              LIMIT p_limit OFFSET p_offset) m), '[]'::jsonb)
  INTO v_morosos_total, v_morosos;

  -- Lo que vencía en el mes y cuánto de eso estaba cobrado al cerrar el mes:
  -- pagos no anulados hechos hasta el último día del mes + cuotas cubiertas
  -- por un abono (adelantada).
  SELECT COALESCE(round(SUM(i.amount) * 100), 0)::bigint,
         COALESCE(round(SUM(CASE WHEN i.status = 'adelantada' THEN i.amount
                                 ELSE LEAST(pay.paid, i.amount) END) * 100), 0)::bigint
    INTO v_vencia, v_cobrado_vencia
    FROM public.installments i
    JOIN public.payment_plans p ON p.id = i.plan_id
    LEFT JOIN public.real_estate_units u ON u.id = p.unit_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(ip.amount), 0) AS paid
        FROM public.installment_payments ip
       WHERE ip.installment_id = i.id AND ip.voided_at IS NULL AND ip.paid_on < v_next
    ) pay ON true
   WHERE i.account_id = a AND p.currency = 'PEN' AND p.status <> 'cancelado'
     AND i.status <> 'condonada' AND i.due_date >= v_month AND i.due_date < v_next
     AND (p_project IS NULL OR u.project_id = p_project);

  -- Cobrado en el mes (pagos no anulados), total y por día.
  v_cobrado := public._gerencia_cobrado_mes(a, v_month, p_project);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('dia', d.dia, 'cents', d.cents) ORDER BY d.dia), '[]'::jsonb)
    INTO v_pordia
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
    'version', 1,
    'asOf', v_today,
    'month', v_month,
    'projectId', p_project,
    'projects', v_projects,
    'cartera', jsonb_build_object('totalCents', v_cartera->'totalCents', 'vigenteCents', v_cartera->'vigenteCents',
                                  'vencidaCents', v_cartera->'vencidaCents', 'planes', v_cartera->'planes'),
    'tramos', v_cartera->'tramos',
    'mes', jsonb_build_object(
      'venciaCents', v_vencia,
      'cobradoDeLoQueVenciaCents', v_cobrado_vencia,
      'cobradoTotalCents', v_cobrado,
      'recaudacionPct', CASE WHEN v_vencia > 0 THEN round(100.0 * v_cobrado_vencia / v_vencia, 1) END,
      'metaCents', v_meta,
      'cumplimientoPct', CASE WHEN v_meta > 0 THEN round(100.0 * v_cobrado / v_meta, 1) END),
    'porDia', v_pordia,
    'morosos', v_morosos,
    'morososTotal', v_morosos_total,
    'otrasMonedas', v_cartera->'otrasMonedas');
END;
$$;
ALTER FUNCTION public.gerencia_cobranza(date, uuid, text, text, integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gerencia_cobranza(date, uuid, text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerencia_cobranza(date, uuid, text, text, integer, integer) TO authenticated;

-- ------------------------------------------------------------
-- 7. Portada de gerencia: cifras del mes, alertas y áreas
-- Cartera y cobrado salen de los mismos ayudantes que gerencia_cobranza (una
-- sola regla); el mes anterior solo calcula el cobrado. Gasto de caja = las
-- cajas que gerencia ve en el panel (cash_panel_companies, 094: todas las de
-- la cuenta para dueño/gerencia), sin reversiones ni traspasos entre cajas.
-- Leads = contactos creados en el mes (misma definición que marketing_summary,
-- 096); separaciones = reservas del mes no rechazadas; la meta de "ventas" en
-- management_goals son separaciones del ERP por ahora (la venta real vendrá
-- del catálogo en la fase 3). Mes y día en hora de Lima. version = 1.
-- Alertas estructuradas (la app arma texto y ruta desde clave), solo las que
-- aplican y en este orden:
--   { clave, nivel, valor, umbral, cents, count }  (cents/count null si no aplica)
--   cartera90_nuevos (rojo): clientes cuya cuota vencida más antigua cruzó 90
--     días en los últimos 30 (atraso 91-120). valor = clientes, umbral = 90
--     (día de cruce), cents = lo que esos clientes deben, count = clientes.
--   meta_cobranza (rojo, solo mes actual): cobrado/meta < día/días del mes -
--     tolerancia. valor = cobrado/meta, umbral = lo esperado, cents = cobrado.
--   banco (ámbar): movimientos por conciliar o revisar con más de 7 días.
--     valor = count = cuántos, umbral = 7 (días).
--   traspasos (ámbar): traspasos pendientes con más de 3 días. Igual, umbral 3.
--   caja (ámbar): gasto del mes > 1.2 x el del mes anterior. valor = cents =
--     gasto del mes, umbral = gasto anterior x 1.2 (céntimos).
-- Áreas, siempre 5: cobranzas (vouchers por revisar de planes activos +
-- traspasos recibidos), legal y postventa (traspasos recibidos),
-- administracion (movimientos por conciliar o revisar), marketing (piezas en
-- revisión). masAntiguoDias: desde el registro pendiente más antiguo (día de
-- Lima); null si no hay o no tiene fecha (los vouchers no la tienen).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gerencia_resumen(p_month date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  -- Umbrales de las alertas (un solo lugar).
  c_dias_banco        constant integer := 7;     -- movimiento de banco sin conciliar
  c_dias_traspasos    constant integer := 3;     -- traspaso sin atender
  c_tolerancia_meta   constant numeric := 0.10;  -- holgura sobre el ritmo esperado de la meta
  c_alza_caja         constant numeric := 1.2;   -- gasto de caja vs mes anterior
  c_cartera_desde     constant integer := 90;    -- cruce a +90 días...
  c_cartera_hasta     constant integer := 120;   -- ...visto en los últimos 30 días

  a uuid;
  v_today date := (now() AT TIME ZONE 'America/Lima')::date;
  v_month date; v_prev date; v_next date; v_dias integer;
  v_cartera jsonb;
  v_cobrado bigint; v_cobrado_prev bigint; v_meta bigint;
  v_total bigint; v_vencida bigint; v_c90 bigint; v_n90 integer; v_n90_cents bigint;
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
  v_month := date_trunc('month', COALESCE(p_month, v_today)::timestamp)::date;
  v_prev := (v_month - interval '1 month')::date;
  v_next := (v_month + interval '1 month')::date;
  v_dias := v_next - v_month;

  -- Cobranza (mismos ayudantes que gerencia_cobranza).
  v_cartera := public._gerencia_cartera(a, NULL, c_cartera_desde, c_cartera_hasta);
  v_cobrado := public._gerencia_cobrado_mes(a, v_month);
  v_cobrado_prev := public._gerencia_cobrado_mes(a, v_prev);
  SELECT g.amount_cents INTO v_meta
    FROM public.management_goals g
   WHERE g.account_id = a AND g.month = v_month AND g.kind = 'cobranza' AND g.project_id IS NULL;
  v_total := (v_cartera->>'totalCents')::bigint;
  v_vencida := (v_cartera->>'vencidaCents')::bigint;
  v_morosidad := CASE WHEN v_total > 0 THEN round(100.0 * v_vencida / v_total, 1) END;
  SELECT (t->>'cents')::bigint INTO v_c90 FROM jsonb_array_elements(v_cartera->'tramos') t WHERE t->>'tramo' = '+90';
  v_c90 := COALESCE(v_c90, 0);
  v_n90 := (v_cartera#>>'{nuevos90,clientes}')::integer;
  v_n90_cents := (v_cartera#>>'{nuevos90,cents}')::bigint;

  -- Gasto de caja: cajas del panel de gerencia, sin reversiones ni traspasos.
  SELECT COALESCE(SUM(e.amount_cents) FILTER (WHERE e.occurred_on >= v_month AND e.occurred_on < v_next), 0)::bigint,
         COALESCE(SUM(e.amount_cents) FILTER (WHERE e.occurred_on >= v_prev AND e.occurred_on < v_month), 0)::bigint
    INTO v_gasto, v_gasto_prev
    FROM public.cash_entries e
   WHERE e.account_id = a AND e.company_id IN (SELECT public.cash_panel_companies(a))
     AND e.kind = 'expense' AND e.reversal_of IS NULL
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
    FROM public.installments i
    JOIN public.payment_plans p ON p.id = i.plan_id
   WHERE i.account_id = a AND i.status = 'pendiente' AND i.voucher_path IS NOT NULL AND p.status = 'activo';
  SELECT count(*) FILTER (WHERE h.to_module = 'cobranzas')::integer,
         MIN((h.created_at AT TIME ZONE 'America/Lima')::date) FILTER (WHERE h.to_module = 'cobranzas'),
         count(*) FILTER (WHERE h.to_module = 'legal')::integer,
         MIN((h.created_at AT TIME ZONE 'America/Lima')::date) FILTER (WHERE h.to_module = 'legal'),
         count(*) FILTER (WHERE h.to_module = 'postventa')::integer,
         MIN((h.created_at AT TIME ZONE 'America/Lima')::date) FILTER (WHERE h.to_module = 'postventa'),
         count(*) FILTER (WHERE (h.created_at AT TIME ZONE 'America/Lima')::date < v_today - c_dias_traspasos)::integer
    INTO v_h_cob, v_h_cob_old, v_h_leg, v_h_leg_old, v_h_pos, v_h_pos_old, v_h_viejos
    FROM public.module_handoffs h WHERE h.account_id = a AND h.status = 'pendiente';
  SELECT count(*)::integer, MIN(m.fecha),
         count(*) FILTER (WHERE m.fecha < v_today - c_dias_banco)::integer
    INTO v_b_pend, v_b_old, v_b_viejos
    FROM public.bank_statement_movements m
   WHERE m.account_id = a AND m.estado IN ('por_conciliar', 'revisar');
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
  IF v_n90 > 0 THEN
    v_alertas := v_alertas || jsonb_build_array(jsonb_build_object(
      'clave', 'cartera90_nuevos', 'nivel', 'rojo', 'valor', v_n90, 'umbral', c_cartera_desde,
      'cents', v_n90_cents, 'count', v_n90));
  END IF;
  IF v_meta IS NOT NULL AND v_month = date_trunc('month', v_today::timestamp)::date
     AND v_cobrado::numeric / v_meta < (extract(day FROM v_today)::numeric / v_dias) - c_tolerancia_meta THEN
    v_alertas := v_alertas || jsonb_build_array(jsonb_build_object(
      'clave', 'meta_cobranza', 'nivel', 'rojo',
      'valor', round(v_cobrado::numeric / v_meta, 4),
      'umbral', round((extract(day FROM v_today)::numeric / v_dias) - c_tolerancia_meta, 4),
      'cents', v_cobrado, 'count', NULL));
  END IF;
  IF v_b_viejos > 0 THEN
    v_alertas := v_alertas || jsonb_build_array(jsonb_build_object(
      'clave', 'banco', 'nivel', 'ambar', 'valor', v_b_viejos, 'umbral', c_dias_banco,
      'cents', NULL, 'count', v_b_viejos));
  END IF;
  IF v_h_viejos > 0 THEN
    v_alertas := v_alertas || jsonb_build_array(jsonb_build_object(
      'clave', 'traspasos', 'nivel', 'ambar', 'valor', v_h_viejos, 'umbral', c_dias_traspasos,
      'cents', NULL, 'count', v_h_viejos));
  END IF;
  IF v_gasto_prev > 0 AND v_gasto > v_gasto_prev * c_alza_caja THEN
    v_alertas := v_alertas || jsonb_build_array(jsonb_build_object(
      'clave', 'caja', 'nivel', 'ambar', 'valor', v_gasto, 'umbral', round(v_gasto_prev * c_alza_caja)::bigint,
      'cents', v_gasto, 'count', NULL));
  END IF;

  RETURN jsonb_build_object(
    'version', 1,
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
