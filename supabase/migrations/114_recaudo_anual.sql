-- 114 RECAUDO ANUAL POR EMPRESA Y PROYECTO. WIO_CRM main.
-- ============================================================
-- Pedido de la revision de Cobranzas en la oficina (2026-11-28): los gerentes
-- quieren ver, por mes y por ano, cuanto tocaba cobrar, cuanto se cobro y que
-- % falta, separado por empresa (Golden / Dream) y por proyecto.
--
-- cobranzas_recaudo_anual(p_year) -> jsonb (version 1):
--   filas:   una por empresa + proyecto + mes del ano pedido
--            { empresa, proyecto, mes, programado, cobrado, cuotas, pagadas }
--   cartera: una por empresa + proyecto, de TODOS los anos
--            { empresa, proyecto, pendiente, vencido }
--   noIncluido: { planesOtraMoneda }
--
-- Reglas:
--   - Se mira la CUOTA por su fecha de vencimiento (no la fecha del pago):
--     la carga de la cartera (2026-11-25) marco las cuotas pagadas sin crear
--     pagos en el libro, asi que el libro no tiene la historia.
--   - programado = monto de las cuotas que vencen en el mes; las condonadas no
--     cuentan. cobrado = lo pagado de esas cuotas: 'pagada' y 'adelantada'
--     cuentan completas; una 'pendiente' cuenta lo que ya tiene pagado (partes).
--   - Solo planes en soles y no cancelados (misma regla que la 106).
--   - Empresa: real_estate_projects.company_key; si esta vacia se deduce del
--     nombre (Colinas, Blue Village y Rinconada = golden; Eucaliptos = dream;
--     "Puesta del Sol - Etapa I" = golden) o, en "Puesta del Sol", de la hoja de
--     origen anotada en el plan por la carga ("Hoja PUESTA DEL SOL ETAPA II..V"
--     = dream). Lo que no se puede deducir sale como empresa null ("Sin empresa").
--   - Pueden verlo gerencia/dueno, cobranzas, contabilidad y administracion de
--     la cuenta de quien llama (igual que gerencia_recaudo_por_cuenta, 106).
--
-- Solo lee. No cambia tablas. Casos: CRM WIO/traspaso-catalogo/probar-114.mjs.
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION public._cobranzas_empresa(p_company_key text, p_proyecto text, p_notas text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_company_key IN ('golden', 'dream', 'terceros') THEN p_company_key
    WHEN lower(COALESCE(p_proyecto, '')) ~ '(colinas|blue village|rinconada)' THEN 'golden'
    WHEN lower(COALESCE(p_proyecto, '')) ~ 'eucaliptos' THEN 'dream'
    WHEN lower(COALESCE(p_proyecto, '')) ~ 'puesta del sol' AND lower(p_proyecto) ~ 'etapa i$' THEN 'golden'
    WHEN lower(COALESCE(p_proyecto, '')) ~ 'puesta del sol'
         AND COALESCE(p_notas, '') ~* 'hoja puesta del sol etapa (ii|iii|iv|v)\M' THEN 'dream'
    ELSE NULL
  END;
$$;
REVOKE ALL ON FUNCTION public._cobranzas_empresa(text, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.cobranzas_recaudo_anual(p_year integer)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_desde date;
  v_hasta date;
  v_hoy date := (now() AT TIME ZONE 'America/Lima')::date;
  v_res jsonb;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT (
       public.is_owner_or_gerencia(a)
       OR EXISTS (SELECT 1 FROM public.profiles p
                   WHERE p.user_id = auth.uid() AND p.account_id = a
                     AND p.area IN ('cobranzas', 'contabilidad', 'administracion'))) THEN
    RAISE EXCEPTION 'Solo gerencia, cobranzas, contabilidad o administracion' USING ERRCODE = '42501';
  END IF;
  IF p_year IS NULL OR p_year < 2000 OR p_year > 2100 THEN
    RAISE EXCEPTION 'Año no válido' USING ERRCODE = '22023';
  END IF;
  v_desde := make_date(p_year, 1, 1);
  v_hasta := make_date(p_year + 1, 1, 1);

  WITH base AS (
    SELECT public._cobranzas_empresa(pr.company_key, pr.name, p.notes) AS empresa,
           COALESCE(pr.name, 'Sin proyecto') AS proyecto,
           i.due_date, i.amount, i.status,
           CASE WHEN i.status IN ('pagada', 'adelantada') THEN i.amount
                ELSE LEAST(i.amount, GREATEST(COALESCE(i.paid_amount, 0), 0)) END AS cobrado
      FROM public.installments i
      JOIN public.payment_plans p ON p.id = i.plan_id
      LEFT JOIN public.real_estate_units u ON u.id = p.unit_id
      LEFT JOIN public.real_estate_projects pr ON pr.id = u.project_id
     WHERE i.account_id = a AND p.currency = 'PEN' AND p.status <> 'cancelado'
       AND i.status <> 'condonada'
  ), filas AS (
    SELECT empresa, proyecto, extract(month FROM due_date)::integer AS mes,
           sum(amount) AS programado, sum(cobrado) AS cobrado,
           count(*)::integer AS cuotas,
           count(*) FILTER (WHERE cobrado >= amount)::integer AS pagadas
      FROM base
     WHERE due_date >= v_desde AND due_date < v_hasta
     GROUP BY 1, 2, 3
  ), cartera AS (
    SELECT empresa, proyecto,
           sum(amount - cobrado) AS pendiente,
           sum(amount - cobrado) FILTER (WHERE due_date < v_hoy) AS vencido
      FROM base
     WHERE cobrado < amount
     GROUP BY 1, 2
  )
  SELECT jsonb_build_object(
    'version', 1,
    'anio', p_year,
    'filas', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'empresa', f.empresa, 'proyecto', f.proyecto, 'mes', f.mes,
                'programado', round(f.programado, 2), 'cobrado', round(f.cobrado, 2),
                'cuotas', f.cuotas, 'pagadas', f.pagadas) ORDER BY f.empresa NULLS LAST, f.proyecto, f.mes)
              FROM filas f), '[]'::jsonb),
    'cartera', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'empresa', c.empresa, 'proyecto', c.proyecto,
                'pendiente', round(c.pendiente, 2), 'vencido', round(COALESCE(c.vencido, 0), 2))
                ORDER BY c.empresa NULLS LAST, c.proyecto)
              FROM cartera c), '[]'::jsonb),
    'noIncluido', jsonb_build_object(
      'planesOtraMoneda', (SELECT count(*) FROM public.payment_plans p
                            WHERE p.account_id = a AND p.currency <> 'PEN' AND p.status <> 'cancelado'))
  ) INTO v_res;
  RETURN v_res;
END;
$$;
ALTER FUNCTION public.cobranzas_recaudo_anual(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cobranzas_recaudo_anual(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cobranzas_recaudo_anual(integer) TO authenticated;

COMMIT;

-- Comprobar despues de correrla (debe decir LISTO):
SELECT CASE WHEN to_regprocedure('public.cobranzas_recaudo_anual(integer)') IS NOT NULL
            THEN 'LISTO' ELSE 'FALTA' END AS resultado_114;
