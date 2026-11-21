-- ============================================================
-- 106_reportes_gerencia.sql — Reportes de Gerencia de Golden (ventas, liberaciones,
-- recaudo por cuenta, comisiones, inversión de marketing y visitas de postventa)
--
-- Pedido de Bryce (2026-11-21): reportes para la app de Gerencia. Esta migración
-- solo AGREGA objetos nuevos, con una única excepción: marketing_review_piece
-- (096), que se reemplaza (ver "ANTES DE APLICAR"). Idempotente: se puede volver
-- a correr (CREATE OR REPLACE, IF NOT EXISTS, políticas recreadas).
--
-- Requiere en la base: 084 (is_owner_or_gerencia), 086 (postventa_cases,
-- appointments), 093 (bank_statement_movements), 096 (marketing_role,
-- marketing_pieces) y, de las migraciones del ERP que viven fuera del repo, la
-- 098 (tablas gh_*), la 100 (gh_entregas_cuenta) y, opcional, la 099
-- (erp_audit_log: si no existe, la auditoría se omite sin fallar).
-- La migración se detiene al inicio si falta algo (mejor frenar que a medias).
--
-- ANTES DE APLICAR (la base real se desvía del repo, como en 091 y 094): comprobar que
-- marketing_review_piece viva es la de la 096 del repo. Esta migración la reemplaza
-- ENTERA (punto 6); si la viva ya cambió, se pisaría ese cambio.
--   SELECT md5(pg_get_functiondef('public.marketing_review_piece(uuid,boolean,text)'::regprocedure));
--   SELECT md5(p.prosrc) FROM pg_proc p
--    WHERE p.proname = 'marketing_review_piece' AND p.pronamespace = 'public'::regnamespace;
--   Deben salir (la 096 del repo, calculada cargándola en PGlite el 2026-11-21):
--     md5(pg_get_functiondef)  a6542c0a9e39ec088325cd28c3ec2030   (saltos de línea LF)
--                              58874376aea3ade0e219c9a15702d275   (CRLF, si se pegó desde un archivo de Windows)
--     md5(prosrc)              e761595cf5d806ba109ccf7db686f898   (LF)
--                              6801fc2e415136de242052d99e6d44a6   (CRLF)
--   La de prosrc es la más fiable; la de pg_get_functiondef puede variar con la versión
--   de Postgres (PGlite vs. la de Supabase). Si no coincide ninguna, comparar a mano antes de aplicar.
--
-- Qué crea:
--   0. Ayudantes internos (sin permiso para authenticated): _reportes_periodo(año, mes)
--      y _reportes_cuenta_golden() (exige gerencia Y que la cuenta sea la de
--      Golden Habitat, porque el catálogo gh_* no tiene account_id).
--   1. gerencia_reporte_ventas(año, mes?): separaciones y vendidos del periodo, por
--      proyecto, por asesor, detalle, comisiones y, sin mes, los 12 meses.
--   2. gerencia_liberaciones(año, mes?): lotes liberados (gh_lotes_historial.tipo =
--      'liberada') por proyecto, por mes y las 20 últimas.
--   3. gerencia_recaudo_por_cuenta(año, mes): lo cobrado en el mes por canal (Caja
--      Ica o método de pago) y cuántos clientes pagaron a tiempo, tarde o no pagaron.
--   4. gerencia_comisiones (tabla) + gerencia_comision_guardar(): comisión por asesor y mes.
--   5. marketing_inversion (tabla) + marketing_inversion_guardar / _borrar / _lista
--      y gerencia_marketing_embudo(mes): inversión, leads, separaciones y costos.
--   6. marketing_review_piece (reemplazo de la 096): gerencia también aprueba o devuelve.
--   7. gerencia_postventa_visitas(desde, hasta): visitas de postventa del rango.
--
-- Reglas de datos (decisiones tomadas; los supuestos están en el informe de entrega):
--   - Catálogo gh_* (098) sin account_id: todo lo que lee gh_* exige que quien llama
--     sea gerencia de la cuenta que devuelve gh_entregas_cuenta() (la única cuenta
--     'Golden Habitat'; igual que 100 y 101). Otra cuenta recibe 42501.
--   - Separación = gh_lotes_solicitudes con estado 'aprobada' cuya fecha de
--     resolución (resuelta, día de Lima) cae en el periodo.
--     Vendida = esa separación, con el lote hoy en estado 'vendido' y siendo la
--     separación vigente del lote (gh_solicitud_vigente, 098). Eso cubre la
--     etapa 'firmado_gerencia' (que marca el lote vendido) y la venta manual del
--     flujo anterior; una venta que luego se liberó deja de contar.
--   - Montos en soles: solo se suman filas en 'PEN'; lo de otras monedas sale
--     aparte en "otrasMonedas". El monto de una separación es el que pagó el
--     cliente al separar (gh_lotes_solicitudes.monto), no el precio del lote
--     (precio_lote, que va en el detalle).
--   - Recaudo: pagos no anulados (voided_at IS NULL) por paid_on en el mes, solo
--     planes en soles y no cancelados (misma regla que _gerencia_cobrado_mes de la
--     097, para que el total cuadre con el tablero). Lo excluido se informa.
--   - Fechas y meses en hora de Lima. "version": 1 en los JSON.
--
-- Casos: C:\...\CRM WIO\traspaso-catalogo\probar-106.mjs (PGlite; fuera del repo).
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- Guarda: sin estas tablas y funciones no se instala nada
-- ------------------------------------------------------------
DO $$
DECLARE
  falta text;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO falta
    FROM unnest(ARRAY['accounts', 'profiles', 'contacts', 'real_estate_projects', 'real_estate_units',
                      'payment_plans', 'installments', 'installment_payments', 'bank_statement_movements',
                      'reservations', 'conversations', 'postventa_cases', 'appointments', 'marketing_pieces',
                      'gh_catalogo', 'gh_lotes_solicitudes', 'gh_lotes_estado', 'gh_lotes_historial',
                      'gh_separacion_etapas']) AS t
   WHERE to_regclass('public.' || t) IS NULL;
  IF falta IS NOT NULL THEN
    RAISE EXCEPTION 'FALTAN_TABLAS_PARA_LA_106: % (corre antes la 098 y revisa que el ERP 043, 084, 086, 093 y 096 estén en esta base)', falta;
  END IF;
  SELECT string_agg(f, ', ' ORDER BY f) INTO falta
    FROM unnest(ARRAY['public.is_owner_or_gerencia(uuid)', 'public.marketing_role(uuid)',
                      'public.gh_entregas_cuenta()', 'public.gh_solicitud_vigente(uuid)']) AS f
   WHERE to_regprocedure(f) IS NULL;
  IF falta IS NOT NULL THEN
    RAISE EXCEPTION 'FALTAN_FUNCIONES_PARA_LA_106: % (084, 096, y 098/100 del ERP)', falta;
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 0. Ayudantes internos (SIN permiso para authenticated)
-- ------------------------------------------------------------
-- Periodo de un reporte: año y mes opcional -> [desde, hasta) como fechas. Con
-- mes nulo es el año entero.
CREATE OR REPLACE FUNCTION public._reportes_periodo(
  p_year integer, p_month integer, OUT p_desde date, OUT p_hasta date)
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF p_year IS NULL OR p_year < 2000 OR p_year > 2100 THEN
    RAISE EXCEPTION 'Año no válido' USING ERRCODE = '22023';
  END IF;
  IF p_month IS NOT NULL AND (p_month < 1 OR p_month > 12) THEN
    RAISE EXCEPTION 'Mes no válido' USING ERRCODE = '22023';
  END IF;
  IF p_month IS NULL THEN
    p_desde := make_date(p_year, 1, 1);
    p_hasta := make_date(p_year + 1, 1, 1);
  ELSE
    p_desde := make_date(p_year, p_month, 1);
    p_hasta := (p_desde + interval '1 month')::date;
  END IF;
END;
$$;
ALTER FUNCTION public._reportes_periodo(integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._reportes_periodo(integer, integer) FROM PUBLIC, anon, authenticated;

-- Cuenta de quien llama, solo si es gerencia (dueño, super admin o área gerencia)
-- DE la cuenta Golden Habitat (a la que pertenece el catálogo gh_*). Si no, 42501.
CREATE OR REPLACE FUNCTION public._reportes_cuenta_golden()
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT public.is_owner_or_gerencia(a) THEN
    RAISE EXCEPTION 'Solo gerencia' USING ERRCODE = '42501';
  END IF;
  IF a IS DISTINCT FROM public.gh_entregas_cuenta() THEN
    RAISE EXCEPTION 'Este reporte es de la cuenta Golden Habitat' USING ERRCODE = '42501';
  END IF;
  RETURN a;
END;
$$;
ALTER FUNCTION public._reportes_cuenta_golden() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._reportes_cuenta_golden() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4a. Comisiones por asesor y mes (tabla; se crea antes porque el reporte de ventas la lee)
-- Con RLS: solo gerencia lee; nadie escribe directo, solo por gerencia_comision_guardar.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gerencia_comisiones (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  month      date NOT NULL CHECK (month = date_trunc('month', month::timestamp)::date),
  asesor     text NOT NULL CHECK (char_length(btrim(asesor)) BETWEEN 1 AND 120),
  monto      numeric(12,2) NOT NULL CHECK (monto > 0),
  nota       text CHECK (nota IS NULL OR char_length(nota) <= 500),
  set_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gerencia_comisiones_unica UNIQUE (account_id, month, asesor)
);
-- El asesor no se repite por mayúsculas ("Ana" y "ana" son la misma persona).
CREATE UNIQUE INDEX IF NOT EXISTS gerencia_comisiones_asesor_ci
  ON public.gerencia_comisiones (account_id, month, lower(btrim(asesor)));

ALTER TABLE public.gerencia_comisiones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gerencia_comisiones FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.gerencia_comisiones FROM authenticated;
GRANT SELECT ON public.gerencia_comisiones TO authenticated;
DROP POLICY IF EXISTS gerencia_comisiones_select ON public.gerencia_comisiones;
CREATE POLICY gerencia_comisiones_select ON public.gerencia_comisiones FOR SELECT
  USING (public.is_owner_or_gerencia(account_id));

-- Pone, cambia o borra (monto NULL o 0) la comisión de un asesor en un mes. El mes se
-- normaliza al primer día. Deja rastro en erp_audit_log si existe (sin fallar si no).
CREATE OR REPLACE FUNCTION public.gerencia_comision_guardar(
  p_month date, p_asesor text, p_monto numeric, p_nota text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_month date;
  v_asesor text := btrim(COALESCE(p_asesor, ''));
  v_nota text := NULLIF(btrim(COALESCE(p_nota, '')), '');
  v_id uuid;
  v_antes numeric;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT public.is_owner_or_gerencia(a) THEN
    RAISE EXCEPTION 'Solo gerencia' USING ERRCODE = '42501';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'Mes no válido' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_asesor) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Asesor no válido' USING ERRCODE = '22023';
  END IF;
  IF p_monto IS NOT NULL AND (p_monto < 0 OR p_monto > 9999999999.99) THEN
    RAISE EXCEPTION 'Monto no válido' USING ERRCODE = '22023';
  END IF;
  IF v_nota IS NOT NULL AND char_length(v_nota) > 500 THEN
    RAISE EXCEPTION 'Nota demasiado larga' USING ERRCODE = '22023';
  END IF;
  v_month := date_trunc('month', p_month::timestamp)::date;

  SELECT g.id, g.monto INTO v_id, v_antes FROM public.gerencia_comisiones g
   WHERE g.account_id = a AND g.month = v_month AND lower(btrim(g.asesor)) = lower(v_asesor);

  IF p_monto IS NULL OR p_monto = 0 THEN
    IF v_id IS NOT NULL THEN
      DELETE FROM public.gerencia_comisiones WHERE id = v_id;
      IF to_regprocedure('public.erp_audit_log(text,text,text,text,jsonb)') IS NOT NULL THEN
        BEGIN
          PERFORM public.erp_audit_log('gerencia', 'anulo', 'comision', v_id::text,
            jsonb_build_object('mes', v_month, 'asesor', v_asesor, 'montoAnterior', v_antes));
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END IF;
    END IF;
    RETURN;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.gerencia_comisiones (account_id, month, asesor, monto, nota, set_by)
    VALUES (a, v_month, v_asesor, round(p_monto, 2), v_nota, auth.uid())
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.gerencia_comisiones
       SET asesor = v_asesor, monto = round(p_monto, 2), nota = v_nota, set_by = auth.uid(), updated_at = now()
     WHERE id = v_id;
  END IF;
  IF to_regprocedure('public.erp_audit_log(text,text,text,text,jsonb)') IS NOT NULL THEN
    BEGIN
      PERFORM public.erp_audit_log('gerencia', CASE WHEN v_antes IS NULL THEN 'creo' ELSE 'edito' END,
        'comision', v_id::text,
        jsonb_build_object('mes', v_month, 'asesor', v_asesor, 'monto', round(p_monto, 2), 'montoAnterior', v_antes));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
END;
$$;
ALTER FUNCTION public.gerencia_comision_guardar(date, text, numeric, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gerencia_comision_guardar(date, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerencia_comision_guardar(date, text, numeric, text) TO authenticated;

-- ------------------------------------------------------------
-- 1. Reporte de ventas
-- Devuelve (version 1):
--   periodo {desde, hasta (excluido)}, mes (o null),
--   totales {separaciones, vendidos, monto, montoVendidos, otrasMonedas:[{moneda, separaciones, monto}]},
--   porProyecto [{proyecto, separaciones, vendidos, monto, montoVendidos}],
--   porAsesor [{asesor, jefeVentas, separaciones, vendidos, monto, montoVendidos, esPromueve}]
--     ordenado por monto; esPromueve = true/false si UN solo perfil de la cuenta
--     coincide con el asesor por nombre completo o correo (sin distinguir mayúsculas),
--     y null si no hay perfil o hay varios,
--   sinVentas [{nombre, email}]: perfiles del área 'ventas' sin ninguna separación
--     aprobada en el periodo, cruzando por nombre o correo; solo se listan los que
--     tienen un nombre o correo que identifica a UN solo perfil (si no, no se puede
--     decir con seguridad y se omiten),
--   detalle [{fecha, proyecto, lote, asesor, jefeVentas, monto, moneda, formaPago, precioLote, vendido}],
--   comisiones [{mes, asesor, monto, nota}] + comisionesTotal,
--   meses: con mes nulo, 12 filas {mes, separaciones, vendidos, monto}; con mes, null.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gerencia_reporte_ventas(p_year integer, p_month integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_desde date; v_hasta date;
  v_ini timestamptz; v_fin timestamptz;
  v_res jsonb;
BEGIN
  a := public._reportes_cuenta_golden();
  SELECT p.p_desde, p.p_hasta INTO v_desde, v_hasta FROM public._reportes_periodo(p_year, p_month) p;
  v_ini := v_desde::timestamp AT TIME ZONE 'America/Lima';
  v_fin := v_hasta::timestamp AT TIME ZONE 'America/Lima';

  WITH base AS (
    SELECT s.id, s.proyecto, COALESCE(NULLIF(btrim(c.nombre), ''), s.proyecto) AS proyecto_nombre, s.lote,
           COALESCE(NULLIF(btrim(s.asesor), ''), '(sin asesor)') AS asesor,
           NULLIF(btrim(s.jefe_ventas), '') AS jefe, s.monto, s.moneda, s.forma_pago, s.precio_lote,
           s.resuelta, (s.resuelta AT TIME ZONE 'America/Lima')::date AS fecha,
           (EXISTS (SELECT 1 FROM public.gh_lotes_estado e
                     WHERE e.proyecto = s.proyecto AND e.lote = s.lote AND e.estado = 'vendido')
            AND public.gh_solicitud_vigente(s.id)) AS vendido
      FROM public.gh_lotes_solicitudes s
      LEFT JOIN public.gh_catalogo c ON c.id = s.proyecto
     WHERE s.estado = 'aprobada' AND s.resuelta >= v_ini AND s.resuelta < v_fin
  ), proy AS (
    SELECT b.proyecto, (array_agg(b.proyecto_nombre))[1] AS nombre,
           count(*)::integer AS separaciones, (count(*) FILTER (WHERE b.vendido))::integer AS vendidos,
           COALESCE(sum(b.monto) FILTER (WHERE b.moneda = 'PEN'), 0) AS monto,
           COALESCE(sum(b.monto) FILTER (WHERE b.moneda = 'PEN' AND b.vendido), 0) AS monto_vendidos
      FROM base b GROUP BY b.proyecto
  ), ases AS (
    SELECT lower(b.asesor) AS clave,
           -- Nombre a mostrar: prefiere la escritura con mayúsculas ("Vera Ventas" sobre "vera ventas").
           (array_agg(b.asesor ORDER BY (b.asesor = lower(b.asesor)), b.resuelta DESC))[1] AS asesor,
           (array_agg(b.jefe ORDER BY b.resuelta DESC) FILTER (WHERE b.jefe IS NOT NULL))[1] AS jefe,
           count(*)::integer AS separaciones, (count(*) FILTER (WHERE b.vendido))::integer AS vendidos,
           COALESCE(sum(b.monto) FILTER (WHERE b.moneda = 'PEN'), 0) AS monto,
           COALESCE(sum(b.monto) FILTER (WHERE b.moneda = 'PEN' AND b.vendido), 0) AS monto_vendidos
      FROM base b GROUP BY lower(b.asesor)
  ), perf AS (
    SELECT p.user_id, p.area, NULLIF(btrim(p.full_name), '') AS nombre, NULLIF(btrim(p.email), '') AS email
      FROM public.profiles p WHERE p.account_id = a
  ), pk AS (
    SELECT lower(f.nombre) AS clave, f.user_id, f.area FROM perf f WHERE f.nombre IS NOT NULL
    UNION
    SELECT lower(f.email), f.user_id, f.area FROM perf f WHERE f.email IS NOT NULL
  ), pu AS (
    -- Claves (nombre o correo) que identifican a UN solo perfil.
    SELECT k.clave, (array_agg(k.user_id))[1] AS user_id, (array_agg(k.area))[1] AS area
      FROM pk k GROUP BY k.clave HAVING count(DISTINCT k.user_id) = 1
  ), sin AS (
    SELECT f.nombre, f.email FROM perf f
     WHERE f.area = 'ventas'
       AND COALESCE(f.nombre, f.email) IS NOT NULL
       AND EXISTS (SELECT 1 FROM pu WHERE pu.clave = lower(COALESCE(f.nombre, f.email)))
       AND NOT EXISTS (SELECT 1 FROM ases x WHERE x.clave = lower(f.nombre) OR x.clave = lower(f.email))
  ), com AS (
    SELECT g.month, g.asesor, g.monto, g.nota FROM public.gerencia_comisiones g
     WHERE g.account_id = a AND g.month >= v_desde AND g.month < v_hasta
  ), meses AS (
    SELECT m.n, count(b.id)::integer AS separaciones, (count(b.id) FILTER (WHERE b.vendido))::integer AS vendidos,
           COALESCE(sum(b.monto) FILTER (WHERE b.moneda = 'PEN'), 0) AS monto
      FROM generate_series(1, 12) AS m(n)
      LEFT JOIN base b ON extract(month FROM b.fecha) = m.n
     GROUP BY m.n
  )
  SELECT jsonb_build_object(
    'version', 1,
    'periodo', jsonb_build_object('desde', v_desde, 'hasta', v_hasta),
    'year', p_year,
    'month', p_month,
    'totales', jsonb_build_object(
      'separaciones', (SELECT count(*) FROM base),
      'vendidos', (SELECT count(*) FROM base WHERE vendido),
      'monto', (SELECT COALESCE(sum(monto), 0) FROM base WHERE moneda = 'PEN'),
      'montoVendidos', (SELECT COALESCE(sum(monto), 0) FROM base WHERE moneda = 'PEN' AND vendido),
      'otrasMonedas', COALESCE((SELECT jsonb_agg(jsonb_build_object('moneda', t.moneda, 'separaciones', t.n, 'monto', t.m) ORDER BY t.moneda)
                                  FROM (SELECT moneda, count(*) AS n, sum(monto) AS m FROM base WHERE moneda <> 'PEN' GROUP BY moneda) t), '[]'::jsonb)),
    'porProyecto', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'proyecto', x.nombre, 'separaciones', x.separaciones, 'vendidos', x.vendidos,
        'monto', x.monto, 'montoVendidos', x.monto_vendidos) ORDER BY x.monto DESC, x.nombre) FROM proy x), '[]'::jsonb),
    'porAsesor', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'asesor', x.asesor, 'jefeVentas', x.jefe, 'separaciones', x.separaciones, 'vendidos', x.vendidos,
        'monto', x.monto, 'montoVendidos', x.monto_vendidos,
        'esPromueve', CASE WHEN pu.user_id IS NULL THEN NULL ELSE (COALESCE(pu.area, '') = 'promueve') END)
        ORDER BY x.monto DESC, x.asesor)
        FROM ases x LEFT JOIN pu ON pu.clave = x.clave), '[]'::jsonb),
    'sinVentas', COALESCE((SELECT jsonb_agg(jsonb_build_object('nombre', s.nombre, 'email', s.email)
                                            ORDER BY COALESCE(s.nombre, s.email)) FROM sin s), '[]'::jsonb),
    'detalle', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'fecha', b.fecha, 'proyecto', b.proyecto_nombre, 'lote', b.lote, 'asesor', b.asesor, 'jefeVentas', b.jefe,
        'monto', b.monto, 'moneda', b.moneda, 'formaPago', b.forma_pago, 'precioLote', b.precio_lote,
        'vendido', b.vendido) ORDER BY b.resuelta DESC, b.id) FROM base b), '[]'::jsonb),
    'comisiones', COALESCE((SELECT jsonb_agg(jsonb_build_object('mes', c.month, 'asesor', c.asesor, 'monto', c.monto, 'nota', c.nota)
                                             ORDER BY c.month, c.asesor) FROM com c), '[]'::jsonb),
    'comisionesTotal', (SELECT COALESCE(sum(monto), 0) FROM com),
    'meses', CASE WHEN p_month IS NULL THEN
        (SELECT jsonb_agg(jsonb_build_object('mes', m.n, 'separaciones', m.separaciones, 'vendidos', m.vendidos, 'monto', m.monto)
                          ORDER BY m.n) FROM meses m) END)
    INTO v_res;
  RETURN v_res;
END;
$$;
ALTER FUNCTION public.gerencia_reporte_ventas(integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gerencia_reporte_ventas(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerencia_reporte_ventas(integer, integer) TO authenticated;

-- ------------------------------------------------------------
-- 2. Liberaciones de lotes
-- gh_lotes_historial.tipo = 'liberada' con 'cuando' en el periodo (día de Lima).
-- {version, periodo, total, porProyecto [{proyecto, liberaciones}], porMes (solo sin
-- mes: 12 filas {mes, liberaciones}), ultimas (las 20 más recientes DEL PERIODO:
-- {proyecto, lote, cuando, por, motivo})}.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gerencia_liberaciones(p_year integer, p_month integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_desde date; v_hasta date;
  v_ini timestamptz; v_fin timestamptz;
  v_res jsonb;
BEGIN
  a := public._reportes_cuenta_golden();
  SELECT p.p_desde, p.p_hasta INTO v_desde, v_hasta FROM public._reportes_periodo(p_year, p_month) p;
  v_ini := v_desde::timestamp AT TIME ZONE 'America/Lima';
  v_fin := v_hasta::timestamp AT TIME ZONE 'America/Lima';

  WITH base AS (
    SELECT h.id, h.proyecto, COALESCE(NULLIF(btrim(c.nombre), ''), h.proyecto) AS proyecto_nombre,
           h.lote, h.cuando, h.por, h.motivo,
           extract(month FROM (h.cuando AT TIME ZONE 'America/Lima'))::integer AS mes
      FROM public.gh_lotes_historial h
      LEFT JOIN public.gh_catalogo c ON c.id = h.proyecto
     WHERE h.tipo = 'liberada' AND h.cuando >= v_ini AND h.cuando < v_fin
  )
  SELECT jsonb_build_object(
    'version', 1,
    'periodo', jsonb_build_object('desde', v_desde, 'hasta', v_hasta),
    'year', p_year,
    'month', p_month,
    'total', (SELECT count(*) FROM base),
    'porProyecto', COALESCE((SELECT jsonb_agg(jsonb_build_object('proyecto', t.nombre, 'liberaciones', t.n)
                                              ORDER BY t.n DESC, t.nombre)
                               FROM (SELECT (array_agg(proyecto_nombre))[1] AS nombre, count(*)::integer AS n
                                       FROM base GROUP BY proyecto) t), '[]'::jsonb),
    'porMes', CASE WHEN p_month IS NULL THEN
        (SELECT jsonb_agg(jsonb_build_object('mes', m.n, 'liberaciones', (SELECT count(*) FROM base b WHERE b.mes = m.n))
                          ORDER BY m.n) FROM generate_series(1, 12) AS m(n)) END,
    'ultimas', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'proyecto', u.proyecto_nombre, 'lote', u.lote, 'cuando', u.cuando, 'por', u.por, 'motivo', u.motivo)
        ORDER BY u.cuando DESC, u.id DESC)
        FROM (SELECT * FROM base ORDER BY cuando DESC, id DESC LIMIT 20) u), '[]'::jsonb))
    INTO v_res;
  RETURN v_res;
END;
$$;
ALTER FUNCTION public.gerencia_liberaciones(integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gerencia_liberaciones(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerencia_liberaciones(integer, integer) TO authenticated;

-- ------------------------------------------------------------
-- 3. Recaudo por cuenta del mes
-- Acceso: gerencia (dueño, super admin, área gerencia) y las áreas cobranzas y
-- contabilidad de la cuenta de quien llama (mismo patrón que gh_entregas_puede_leer
-- de la 100). Es de la cuenta de quien llama: otra cuenta ve solo lo suyo.
-- Devuelve (version 1): periodo, total, pagos, porCuenta [{canal, monto, pagos,
-- porcentaje}] (canal = 'Caja Ica' si el pago está enlazado a un movimiento del
-- banco, bank_statement_movements.payment_id; si no, el método de pago en minúsculas
-- y sin tildes, o 'sin_metodo'), noIncluido {otrasMonedas, planesCancelados {pagos, monto}},
-- clientes [{proyecto, clientes, aTiempo, tarde, noPagaron, pctATiempo, pctTarde,
-- pctNoPagaron}] y clientesTotal con la misma forma.
-- Clientes: planes 'activo' o 'pagado' en soles con cuotas que VENCÍAN en el mes
-- (sin las condonadas). Por cliente (contacto) y proyecto, mirando todos sus pagos
-- hasta hoy: a tiempo = todas cubiertas y la última pagada hasta el vencimiento
-- (o adelantada); tarde = todas cubiertas pero alguna pagada después de vencer;
-- no pagó = alguna cuota sigue sin cubrirse. Una cuota sin fecha de pago conocida
-- cuenta como a tiempo.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gerencia_recaudo_por_cuenta(p_year integer, p_month integer)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_desde date; v_hasta date;
  v_res jsonb;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT (
       public.is_owner_or_gerencia(a)
       OR EXISTS (SELECT 1 FROM public.profiles p
                   WHERE p.user_id = auth.uid() AND p.account_id = a AND p.area IN ('cobranzas', 'contabilidad'))) THEN
    RAISE EXCEPTION 'Solo gerencia, cobranzas o contabilidad' USING ERRCODE = '42501';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'Mes no válido' USING ERRCODE = '22023';
  END IF;
  SELECT p.p_desde, p.p_hasta INTO v_desde, v_hasta FROM public._reportes_periodo(p_year, p_month) p;

  WITH pagos AS (
    SELECT ip.id, ip.amount,
           CASE WHEN EXISTS (SELECT 1 FROM public.bank_statement_movements m
                              WHERE m.account_id = a AND m.payment_id = ip.id) THEN 'Caja Ica'
                ELSE COALESCE(NULLIF(translate(lower(btrim(ip.method)), 'áéíóúü', 'aeiouu'), ''), 'sin_metodo') END AS canal
      FROM public.installment_payments ip
      JOIN public.payment_plans p ON p.id = ip.plan_id
     WHERE ip.account_id = a AND ip.voided_at IS NULL AND p.currency = 'PEN' AND p.status <> 'cancelado'
       AND ip.paid_on >= v_desde AND ip.paid_on < v_hasta
  ), canales AS (
    SELECT canal, sum(amount) AS monto, count(*)::integer AS n FROM pagos GROUP BY canal
  ), tot AS (
    SELECT COALESCE(sum(amount), 0) AS monto, count(*)::integer AS n FROM pagos
  ), cuotas AS (
    SELECT COALESCE(p.contact_id, p.id) AS gkey, pr.id AS pid, COALESCE(pr.name, 'Sin proyecto') AS pname,
           i.amount, i.due_date, i.status,
           COALESCE(sum(ip.amount) FILTER (WHERE ip.voided_at IS NULL), 0) AS pagado,
           COALESCE(max(ip.paid_on) FILTER (WHERE ip.voided_at IS NULL),
                    (i.paid_at AT TIME ZONE 'America/Lima')::date) AS ultimo
      FROM public.installments i
      JOIN public.payment_plans p ON p.id = i.plan_id
      LEFT JOIN public.real_estate_units u ON u.id = p.unit_id
      LEFT JOIN public.real_estate_projects pr ON pr.id = u.project_id
      LEFT JOIN public.installment_payments ip ON ip.installment_id = i.id
     WHERE i.account_id = a AND p.account_id = a AND p.currency = 'PEN' AND p.status IN ('activo', 'pagado')
       AND i.status <> 'condonada' AND i.due_date >= v_desde AND i.due_date < v_hasta
     GROUP BY p.contact_id, p.id, pr.id, pr.name, i.id
  ), nivel AS (
    -- 1 a tiempo, 2 tarde, 3 no pagó (por cuota)
    SELECT c.gkey, c.pid, c.pname,
           CASE WHEN NOT (c.status IN ('pagada', 'adelantada') OR c.pagado >= c.amount) THEN 3
                WHEN c.status = 'adelantada' THEN 1
                WHEN c.ultimo IS NOT NULL AND c.ultimo > c.due_date THEN 2
                ELSE 1 END AS n
      FROM cuotas c
  ), cli AS (
    SELECT gkey, pid, pname, max(n) AS n FROM nivel GROUP BY gkey, pid, pname
  ), proy AS (
    SELECT pid, pname, count(*)::integer AS clientes,
           (count(*) FILTER (WHERE n = 1))::integer AS a_tiempo,
           (count(*) FILTER (WHERE n = 2))::integer AS tarde,
           (count(*) FILTER (WHERE n = 3))::integer AS no_pagaron
      FROM cli GROUP BY pid, pname
  ), proy_t AS (
    SELECT COALESCE(sum(clientes), 0)::integer AS clientes, COALESCE(sum(a_tiempo), 0)::integer AS a_tiempo,
           COALESCE(sum(tarde), 0)::integer AS tarde, COALESCE(sum(no_pagaron), 0)::integer AS no_pagaron
      FROM proy
  )
  SELECT jsonb_build_object(
    'version', 1,
    'periodo', jsonb_build_object('desde', v_desde, 'hasta', v_hasta),
    'year', p_year,
    'month', p_month,
    'total', (SELECT monto FROM tot),
    'pagos', (SELECT n FROM tot),
    'porCuenta', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'canal', c.canal, 'monto', c.monto, 'pagos', c.n,
        'porcentaje', CASE WHEN (SELECT monto FROM tot) > 0 THEN round(100.0 * c.monto / (SELECT monto FROM tot), 1) END)
        ORDER BY c.monto DESC, c.canal) FROM canales c), '[]'::jsonb),
    'noIncluido', jsonb_build_object(
      'otrasMonedas', (SELECT count(*) FROM public.installment_payments ip
                         JOIN public.payment_plans p ON p.id = ip.plan_id
                        WHERE ip.account_id = a AND ip.voided_at IS NULL AND p.currency <> 'PEN'
                          AND ip.paid_on >= v_desde AND ip.paid_on < v_hasta),
      'planesCancelados', jsonb_build_object(
        'pagos', (SELECT count(*) FROM public.installment_payments ip
                    JOIN public.payment_plans p ON p.id = ip.plan_id
                   WHERE ip.account_id = a AND ip.voided_at IS NULL AND p.currency = 'PEN' AND p.status = 'cancelado'
                     AND ip.paid_on >= v_desde AND ip.paid_on < v_hasta),
        'monto', (SELECT COALESCE(sum(ip.amount), 0) FROM public.installment_payments ip
                    JOIN public.payment_plans p ON p.id = ip.plan_id
                   WHERE ip.account_id = a AND ip.voided_at IS NULL AND p.currency = 'PEN' AND p.status = 'cancelado'
                     AND ip.paid_on >= v_desde AND ip.paid_on < v_hasta))),
    'clientes', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'proyecto', x.pname, 'clientes', x.clientes, 'aTiempo', x.a_tiempo, 'tarde', x.tarde, 'noPagaron', x.no_pagaron,
        'pctATiempo', round(100.0 * x.a_tiempo / x.clientes, 1),
        'pctTarde', round(100.0 * x.tarde / x.clientes, 1),
        'pctNoPagaron', round(100.0 * x.no_pagaron / x.clientes, 1)) ORDER BY x.clientes DESC, x.pname) FROM proy x), '[]'::jsonb),
    'clientesTotal', (SELECT jsonb_build_object(
        'clientes', t.clientes, 'aTiempo', t.a_tiempo, 'tarde', t.tarde, 'noPagaron', t.no_pagaron,
        'pctATiempo', CASE WHEN t.clientes > 0 THEN round(100.0 * t.a_tiempo / t.clientes, 1) END,
        'pctTarde', CASE WHEN t.clientes > 0 THEN round(100.0 * t.tarde / t.clientes, 1) END,
        'pctNoPagaron', CASE WHEN t.clientes > 0 THEN round(100.0 * t.no_pagaron / t.clientes, 1) END) FROM proy_t t))
    INTO v_res;
  RETURN v_res;
END;
$$;
ALTER FUNCTION public.gerencia_recaudo_por_cuenta(integer, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gerencia_recaudo_por_cuenta(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerencia_recaudo_por_cuenta(integer, integer) TO authenticated;

-- ------------------------------------------------------------
-- 5. Inversión de marketing
-- Tabla con RLS: la leen marketing (cualquier rol, incluido el equipo) y gerencia;
-- nadie escribe directo, solo las RPC de abajo (jefe de marketing o gerencia).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketing_inversion (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  month      date NOT NULL CHECK (month = date_trunc('month', month::timestamp)::date),
  negocio    text NOT NULL CHECK (negocio IN ('golden', 'dream', 'el_hato', 'cafe', 'otro')),
  project_id uuid REFERENCES public.real_estate_projects(id) ON DELETE SET NULL,
  rubro      text NOT NULL CHECK (rubro IN ('pauta', 'modelo', 'decoracion', 'grabacion', 'sueldo', 'otro')),
  monto      numeric(12,2) NOT NULL CHECK (monto > 0),
  nota       text CHECK (nota IS NULL OR char_length(nota) <= 500),
  set_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_inversion_account_month ON public.marketing_inversion (account_id, month);

ALTER TABLE public.marketing_inversion ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_inversion FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.marketing_inversion FROM authenticated;
GRANT SELECT ON public.marketing_inversion TO authenticated;
DROP POLICY IF EXISTS marketing_inversion_select ON public.marketing_inversion;
CREATE POLICY marketing_inversion_select ON public.marketing_inversion FOR SELECT
  USING (public.marketing_role(account_id) IS NOT NULL OR public.is_owner_or_gerencia(account_id));

-- Alta (p_id NULL) o cambio (p_id de una fila de la misma cuenta). Devuelve el id.
CREATE OR REPLACE FUNCTION public.marketing_inversion_guardar(
  p_month date, p_negocio text, p_rubro text, p_monto numeric,
  p_project uuid DEFAULT NULL, p_nota text DEFAULT NULL, p_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_month date;
  v_nota text := NULLIF(btrim(COALESCE(p_nota, '')), '');
  v_id uuid;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT (public.marketing_role(a) IS NOT DISTINCT FROM 'jefe' OR public.is_owner_or_gerencia(a)) THEN
    RAISE EXCEPTION 'Solo el jefe de marketing o gerencia' USING ERRCODE = '42501';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'Mes no válido' USING ERRCODE = '22023';
  END IF;
  IF p_negocio IS NULL OR p_negocio NOT IN ('golden', 'dream', 'el_hato', 'cafe', 'otro') THEN
    RAISE EXCEPTION 'Negocio no válido' USING ERRCODE = '22023';
  END IF;
  IF p_rubro IS NULL OR p_rubro NOT IN ('pauta', 'modelo', 'decoracion', 'grabacion', 'sueldo', 'otro') THEN
    RAISE EXCEPTION 'Rubro no válido' USING ERRCODE = '22023';
  END IF;
  IF p_monto IS NULL OR p_monto <= 0 OR p_monto > 9999999999.99 THEN
    RAISE EXCEPTION 'Monto no válido' USING ERRCODE = '22023';
  END IF;
  IF v_nota IS NOT NULL AND char_length(v_nota) > 500 THEN
    RAISE EXCEPTION 'Nota demasiado larga' USING ERRCODE = '22023';
  END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.real_estate_projects r WHERE r.id = p_project AND r.account_id = a) THEN
    RAISE EXCEPTION 'Proyecto no válido' USING ERRCODE = '22023';
  END IF;
  v_month := date_trunc('month', p_month::timestamp)::date;

  IF p_id IS NULL THEN
    INSERT INTO public.marketing_inversion (account_id, month, negocio, project_id, rubro, monto, nota, set_by)
    VALUES (a, v_month, p_negocio, p_project, p_rubro, round(p_monto, 2), v_nota, auth.uid())
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.marketing_inversion
       SET month = v_month, negocio = p_negocio, project_id = p_project, rubro = p_rubro,
           monto = round(p_monto, 2), nota = v_nota, set_by = auth.uid(), updated_at = now()
     WHERE id = p_id AND account_id = a
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'Inversión no encontrada' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  IF to_regprocedure('public.erp_audit_log(text,text,text,text,jsonb)') IS NOT NULL THEN
    BEGIN
      PERFORM public.erp_audit_log('gerencia', CASE WHEN p_id IS NULL THEN 'creo' ELSE 'edito' END,
        'marketing_inversion', v_id::text,
        jsonb_build_object('mes', v_month, 'negocio', p_negocio, 'rubro', p_rubro, 'monto', round(p_monto, 2)));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN v_id;
END;
$$;
ALTER FUNCTION public.marketing_inversion_guardar(date, text, text, numeric, uuid, text, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.marketing_inversion_guardar(date, text, text, numeric, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketing_inversion_guardar(date, text, text, numeric, uuid, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.marketing_inversion_borrar(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  r public.marketing_inversion%ROWTYPE;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT (public.marketing_role(a) IS NOT DISTINCT FROM 'jefe' OR public.is_owner_or_gerencia(a)) THEN
    RAISE EXCEPTION 'Solo el jefe de marketing o gerencia' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.marketing_inversion WHERE id = p_id AND account_id = a RETURNING * INTO r;
  IF r.id IS NULL THEN
    RAISE EXCEPTION 'Inversión no encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF to_regprocedure('public.erp_audit_log(text,text,text,text,jsonb)') IS NOT NULL THEN
    BEGIN
      PERFORM public.erp_audit_log('gerencia', 'anulo', 'marketing_inversion', r.id::text,
        jsonb_build_object('mes', r.month, 'negocio', r.negocio, 'rubro', r.rubro, 'monto', r.monto));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
END;
$$;
ALTER FUNCTION public.marketing_inversion_borrar(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.marketing_inversion_borrar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketing_inversion_borrar(uuid) TO authenticated;

-- Lista del mes (marketing en cualquier rol y gerencia). Sin mes = el mes actual de Lima.
CREATE OR REPLACE FUNCTION public.marketing_inversion_lista(p_month date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_mes date := date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'America/Lima')::date)::timestamp)::date;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT (public.marketing_role(a) IS NOT NULL OR public.is_owner_or_gerencia(a)) THEN
    RAISE EXCEPTION 'Solo marketing o gerencia' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'version', 1,
    'month', v_mes,
    'total', (SELECT COALESCE(sum(i.monto), 0) FROM public.marketing_inversion i WHERE i.account_id = a AND i.month = v_mes),
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', i.id, 'negocio', i.negocio, 'rubro', i.rubro, 'monto', i.monto, 'nota', i.nota,
        'projectId', i.project_id, 'projectName', r.name, 'updatedAt', i.updated_at)
        ORDER BY i.negocio, i.rubro, i.created_at, i.id)
        FROM public.marketing_inversion i
        LEFT JOIN public.real_estate_projects r ON r.id = i.project_id
       WHERE i.account_id = a AND i.month = v_mes), '[]'::jsonb));
END;
$$;
ALTER FUNCTION public.marketing_inversion_lista(date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.marketing_inversion_lista(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketing_inversion_lista(date) TO authenticated;

-- Embudo de marketing del mes para gerencia. Leads = contactos creados en el mes
-- (misma definición que marketing_leads/marketing_summary de la 096: día de Lima),
-- asesor = quien tiene asignada su conversación más reciente (como marketing_leads),
-- separó = el contacto tiene alguna reserva no rechazada (campo "separated"; cuenta
-- contactos, no reservas). Los leads no traen negocio: el costo por lead/separación
-- se da con toda la inversión (conTodoNegocio) y solo con la de 'golden' (soloGolden).
-- {version, month, inversion {total, porNegocio, porRubro, porNegocioRubro},
--  leads {total, separaron, porAsesor [{asesor, leads, separaron}]},
--  costos {conTodoNegocio {porLead, porSeparacion}, soloGolden {porLead, porSeparacion}}}
CREATE OR REPLACE FUNCTION public.gerencia_marketing_embudo(p_month date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_mes date := date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'America/Lima')::date)::timestamp)::date;
  v_next date;
  v_tot numeric; v_gol numeric; v_leads integer; v_sep integer;
  v_inv jsonb; v_porasesor jsonb;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT public.is_owner_or_gerencia(a) THEN
    RAISE EXCEPTION 'Solo gerencia' USING ERRCODE = '42501';
  END IF;
  v_next := (v_mes + interval '1 month')::date;

  SELECT COALESCE(sum(i.monto), 0), COALESCE(sum(i.monto) FILTER (WHERE i.negocio = 'golden'), 0)
    INTO v_tot, v_gol
    FROM public.marketing_inversion i WHERE i.account_id = a AND i.month = v_mes;
  v_inv := jsonb_build_object(
    'total', v_tot,
    'porNegocio', COALESCE((SELECT jsonb_agg(jsonb_build_object('negocio', t.negocio, 'monto', t.m) ORDER BY t.m DESC, t.negocio)
        FROM (SELECT negocio, sum(monto) AS m FROM public.marketing_inversion WHERE account_id = a AND month = v_mes GROUP BY negocio) t), '[]'::jsonb),
    'porRubro', COALESCE((SELECT jsonb_agg(jsonb_build_object('rubro', t.rubro, 'monto', t.m) ORDER BY t.m DESC, t.rubro)
        FROM (SELECT rubro, sum(monto) AS m FROM public.marketing_inversion WHERE account_id = a AND month = v_mes GROUP BY rubro) t), '[]'::jsonb),
    'porNegocioRubro', COALESCE((SELECT jsonb_agg(jsonb_build_object('negocio', t.negocio, 'rubro', t.rubro, 'monto', t.m) ORDER BY t.negocio, t.rubro)
        FROM (SELECT negocio, rubro, sum(monto) AS m FROM public.marketing_inversion WHERE account_id = a AND month = v_mes GROUP BY negocio, rubro) t), '[]'::jsonb));

  WITH leads AS (
    SELECT c.id,
           COALESCE((SELECT COALESCE(NULLIF(p.full_name, ''), p.email) FROM public.conversations v
                       JOIN public.profiles p ON p.user_id = v.assigned_agent_id AND p.account_id = a
                      WHERE v.contact_id = c.id AND v.assigned_agent_id IS NOT NULL
                      ORDER BY v.created_at DESC LIMIT 1), 'Sin asesor') AS asesor,
           EXISTS (SELECT 1 FROM public.reservations r
                    WHERE r.contact_id = c.id AND r.account_id = a AND r.status <> 'rechazada') AS separo
      FROM public.contacts c
     WHERE c.account_id = a
       AND (c.created_at AT TIME ZONE 'America/Lima')::date >= v_mes
       AND (c.created_at AT TIME ZONE 'America/Lima')::date < v_next
  )
  SELECT (SELECT count(*)::integer FROM leads),
         (SELECT (count(*) FILTER (WHERE separo))::integer FROM leads),
         COALESCE((SELECT jsonb_agg(jsonb_build_object('asesor', t.asesor, 'leads', t.n, 'separaron', t.s) ORDER BY t.n DESC, t.asesor)
                     FROM (SELECT asesor, count(*)::integer AS n, (count(*) FILTER (WHERE separo))::integer AS s
                             FROM leads GROUP BY asesor) t), '[]'::jsonb)
    INTO v_leads, v_sep, v_porasesor;

  RETURN jsonb_build_object(
    'version', 1,
    'month', v_mes,
    'inversion', v_inv,
    'leads', jsonb_build_object('total', v_leads, 'separaron', v_sep, 'porAsesor', v_porasesor),
    'costos', jsonb_build_object(
      'conTodoNegocio', jsonb_build_object(
        'porLead', CASE WHEN v_leads > 0 THEN round(v_tot / v_leads, 2) END,
        'porSeparacion', CASE WHEN v_sep > 0 THEN round(v_tot / v_sep, 2) END),
      'soloGolden', jsonb_build_object(
        'porLead', CASE WHEN v_leads > 0 THEN round(v_gol / v_leads, 2) END,
        'porSeparacion', CASE WHEN v_sep > 0 THEN round(v_gol / v_sep, 2) END)));
END;
$$;
ALTER FUNCTION public.gerencia_marketing_embudo(date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gerencia_marketing_embudo(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerencia_marketing_embudo(date) TO authenticated;

-- ------------------------------------------------------------
-- 6. marketing_review_piece: además del jefe de marketing, gerencia aprueba o devuelve
-- Copia ENTERA de la de 096; solo cambian las dos condiciones de acceso (marcadas
-- con "106"). Nota: marketing_role (096) ya devuelve 'jefe' para dueño/gerencia, así
-- que en el repo el cambio es de claridad: ya no depende de ese atajo. El disparador
-- marketing_pieces_guard (096) sí sigue exigiendo marketing_role = 'jefe' para el
-- UPDATE; no se toca.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.marketing_review_piece(p_piece uuid, p_approve boolean, p_note text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_acc uuid;
  v_status text;
BEGIN
  SELECT account_id, status INTO v_acc, v_status FROM public.marketing_pieces WHERE id = p_piece FOR UPDATE;
  -- 106: gerencia también ve la pieza aunque marketing_role no la reconozca.
  IF v_acc IS NULL OR (public.marketing_role(v_acc) IS NULL AND NOT public.is_owner_or_gerencia(v_acc)) THEN
    RAISE EXCEPTION 'Pieza no encontrada' USING ERRCODE = 'P0002'; END IF;
  -- 106: jefe de marketing o gerencia (antes: solo el jefe).
  IF public.marketing_role(v_acc) IS DISTINCT FROM 'jefe' AND NOT public.is_owner_or_gerencia(v_acc) THEN
    RAISE EXCEPTION 'Solo el jefe de marketing o gerencia' USING ERRCODE = '42501'; END IF;
  IF v_status = 'publicada' THEN
    RAISE EXCEPTION 'La pieza ya está publicada' USING ERRCODE = '22023'; END IF;
  IF NOT COALESCE(p_approve, false) AND length(btrim(COALESCE(p_note, ''))) = 0 THEN
    RAISE EXCEPTION 'Escribe una nota al devolver la pieza' USING ERRCODE = '22023'; END IF;
  UPDATE public.marketing_pieces
     SET status = CASE WHEN p_approve THEN 'aprobada' ELSE 'devuelta' END,
         reviewed_by = auth.uid(),
         review_note = NULLIF(btrim(COALESCE(p_note, '')), '')
   WHERE id = p_piece;
END;
$$;
ALTER FUNCTION public.marketing_review_piece(uuid, boolean, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.marketing_review_piece(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketing_review_piece(uuid, boolean, text) TO authenticated;

-- ------------------------------------------------------------
-- 7. Visitas de postventa del rango (solo gerencia, de su cuenta)
-- Una fila por caso de postventa (086) con visita: la cita vigente del caso
-- (postventa_cases.appointment_id -> appointments.starts_at, hora de Lima). Rango
-- inclusivo en días de Lima, máximo 366 días.
-- [{fecha, hora ('HH24:MI'), cliente, tema, estado (del caso: nuevo|agendado|resuelto),
--   estadoCita (agendada|cumplida|cancelada), atiende}] + total.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gerencia_postventa_visitas(p_desde date, p_hasta date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_ini timestamptz; v_fin timestamptz;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT public.is_owner_or_gerencia(a) THEN
    RAISE EXCEPTION 'Solo gerencia' USING ERRCODE = '42501';
  END IF;
  IF p_desde IS NULL OR p_hasta IS NULL OR p_hasta < p_desde OR p_hasta - p_desde > 365 THEN
    RAISE EXCEPTION 'Rango de fechas no válido' USING ERRCODE = '22023';
  END IF;
  v_ini := p_desde::timestamp AT TIME ZONE 'America/Lima';
  v_fin := (p_hasta + 1)::timestamp AT TIME ZONE 'America/Lima';
  RETURN (
    SELECT jsonb_build_object(
      'version', 1,
      'desde', p_desde,
      'hasta', p_hasta,
      'total', count(*),
      'items', COALESCE(jsonb_agg(t.j ORDER BY t.starts_at, t.id), '[]'::jsonb))
    FROM (
      SELECT ap.starts_at, pc.id,
             jsonb_build_object(
               'fecha', (ap.starts_at AT TIME ZONE 'America/Lima')::date,
               'hora', to_char(ap.starts_at AT TIME ZONE 'America/Lima', 'HH24:MI'),
               'cliente', c.name,
               'tema', pc.topic,
               'estado', pc.status,
               'estadoCita', ap.status,
               'atiende', COALESCE(NULLIF(btrim(u.full_name), ''), u.email)) AS j
        FROM public.postventa_cases pc
        JOIN public.appointments ap ON ap.id = pc.appointment_id
        LEFT JOIN public.contacts c ON c.id = pc.contact_id
        LEFT JOIN public.profiles u ON u.user_id = ap.user_id AND u.account_id = a
       WHERE pc.account_id = a AND ap.starts_at >= v_ini AND ap.starts_at < v_fin) t);
END;
$$;
ALTER FUNCTION public.gerencia_postventa_visitas(date, date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gerencia_postventa_visitas(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerencia_postventa_visitas(date, date) TO authenticated;

COMMIT;
