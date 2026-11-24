-- ============================================================
-- 112_tecnica_solicitudes.sql — El área técnica de Golden Habitat envía solicitudes a Gerencia
-- (incluye el tipo nuevo 'presupuesto')
-- WIO_CRM, por PR (main protegido). Correr en el SQL Editor de wioCRM (WioSuite).
--
-- Problema: flujo_rol() (101) devolvía NULL para el área técnica, así que técnica no podía
-- crear, ver ni cancelar solicitudes a Gerencia (gerencia_solicitudes). Esta migración le
-- da el rol 'tecnica' al flujo y agrega el tipo 'presupuesto'.
--
-- Qué cambia (REEMPLAZA 7 funciones de la 101; no toca tablas salvo el CHECK del tipo):
--   1. flujo_rol(): devuelve 'tecnica' a quien sea miembro operativo del área técnica
--      (jefe o equipo en tecnica_members, o perfil con area = 'tecnica'), usando el mismo
--      candado de miembro activo de la 111 (tecnica_rol_operativo_of: cuenta activa, sin
--      viewer, sin área promueve). Orden: gerencia/dueño primero ('gerencia'); luego las
--      áreas administracion, cobranzas, contabilidad y legal tal cual (quien tiene una de
--      esas áreas conserva su rol aunque esté en tecnica_members); luego 'tecnica'; luego
--      ventas y marketing. Así Pio (área ventas, equipo técnico) queda como 'tecnica'.
--      Para todos los demás el resultado es el mismo de antes.
--   2. flujo_app('tecnica') = 'tecnica' (erp_audit_events admite app 'tecnica' desde la 099).
--   3. Tipo 'presupuesto': entra al CHECK de gerencia_solicitudes.kind (se reemplaza la
--      restricción conservando los 6 tipos de antes) y a todas las listas de tipos:
--      solicitud_crear, flujo_solicitudes_pagina y gerencia_solicitudes_conteo
--      (por_kind pasa a tener 7 claves; las anteriores no cambian).
--   4. solicitud_crear: técnica crea 'presupuesto', 'compra_obra' y 'otro'; gerencia crea
--      además 'presupuesto'. Cobranzas, administración y contabilidad quedan EXACTAMENTE
--      como estaban (no pueden crear 'presupuesto').
--   5. mis_solicitudes y solicitud_cancelar: técnica entra a la lista de roles permitidos
--      y se comporta como las demás áreas (ve las suyas y las de su área; cancela solo
--      las que creó y siguen pendientes).
--
-- Auditoría de puertas (hecha antes de cambiar flujo_rol, sobre 101-111): flujo_rol() solo
-- lo llaman flujo_exigir y flujo_solicitud_insertar (ambas internas). TODAS las llamadas a
-- flujo_exigir de 101, 102 y 110 pasan una lista explícita de roles que NO incluye
-- 'tecnica' (salvo las dos que esta migración abre a propósito: mis_solicitudes y
-- solicitud_cancelar); ninguna función compara flujo_rol() con IS NOT NULL. flujo_solicitud_insertar
-- sí solo exige rol no nulo, pero solo se llama desde solicitud_crear (con lista de
-- tipos por rol) y desde promocion_enviar (102, exige cobranzas o gerencia). 108, 109 y 111
-- no usan flujo_*. Conclusión: devolver 'tecnica' en vez de NULL no abre ninguna puerta
-- que no se abra aquí; no hizo falta cerrar nada más. La prueba lo confirma llamando a
-- las funciones de gerencia, delegaciones, promociones, cartas, contratos y entregas
-- como técnica (todas dan 42501).
--
-- Requiere (la migración se detiene con un mensaje claro si falta algo): 101 (solicitudes
-- a gerencia), 099 (auditoría con app 'tecnica') y 111 (tecnica_members y
-- tecnica_rol_operativo_of).
--
-- ANTES de aplicar, comprobar a mano que las funciones vivas son las del repo (la
-- migración lo comprueba sola, esto es para verlo antes de correrla). La huella es el
-- md5 del cuerpo SIN espacios ni saltos de línea (así no importa CRLF/LF):
--   SELECT p.proname, md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p
--    WHERE p.pronamespace = 'public'::regnamespace
--      AND p.proname IN ('flujo_rol', 'flujo_app', 'flujo_solicitudes_pagina', 'solicitud_crear',
--                        'solicitud_cancelar', 'mis_solicitudes', 'gerencia_solicitudes_conteo');
--   Deben salir:
--     flujo_rol                    e91f3124fb8422c0c79d56a184dcee49  (101)
--     flujo_app                    6e3bd37fff5a476099e6951d40f13697  (101)
--     flujo_solicitudes_pagina     0a79837ead37801b2cb2725c1577bb90  (101)
--     solicitud_crear              116a99b3441f193be2d7bddf38a330cd  (101)
--     solicitud_cancelar           92caa97310af7a39c6734667ea40afbf  (101)
--     mis_solicitudes              9deb52e55c17e0d975f3e7eb45630798  (101)
--     gerencia_solicitudes_conteo  3e5cbe9efff2a46adf68cf6eda5b870a  (101)
--   Si ya corrió la 112, el cuerpo lleva la marca '112_tecnica_solicitudes' y también pasa.
--   Si no coinciden, NO aplicar: la base real se desvía del repo.
--
-- Casos: CRM WIO\traspaso-catalogo\probar-112.mjs (PGlite, con la 101 y la 111 reales).
-- Idempotente — se puede volver a correr.
-- ============================================================
BEGIN;

-- ============================================================
-- 0. Guardas: lo que debe existir y huella de lo que se reemplaza
-- ============================================================
DO $$
DECLARE
  f record;
  v_src text;
  v_faltan text;
BEGIN
  SELECT string_agg(t, ', ') INTO v_faltan
    FROM unnest(ARRAY['gerencia_solicitudes', 'gerencia_delegaciones', 'tecnica_members']) AS t
   WHERE to_regclass('public.' || t) IS NULL;
  IF v_faltan IS NOT NULL THEN
    RAISE EXCEPTION 'FALTAN_TABLAS_PARA_LA_112: % (aplicar antes la 101 y la 111; tecnica_members es de la 111)', v_faltan;
  END IF;

  SELECT string_agg(t, ', ') INTO v_faltan
    FROM unnest(ARRAY['flujo_rol()', 'flujo_app(text)', 'flujo_exigir(text[],text)', 'flujo_cuenta()', 'flujo_nombre()',
                      'flujo_audit(text,text,text,text,jsonb)', 'flujo_texto(text,text,integer,integer)',
                      'flujo_solicitud_insertar(text,text,text,jsonb,text)',
                      'flujo_solicitudes_pagina(uuid,text,text,uuid,text,integer,integer)',
                      'solicitud_crear(text,text,text,jsonb,text)', 'solicitud_cancelar(uuid)',
                      'mis_solicitudes(text,text,integer,integer)', 'gerencia_solicitudes_conteo()',
                      'is_owner_or_gerencia(uuid)', 'tecnica_rol_operativo_of(uuid,uuid)']) AS t
   WHERE to_regprocedure('public.' || t) IS NULL;
  IF v_faltan IS NOT NULL THEN
    RAISE EXCEPTION 'FALTAN_FUNCIONES_PARA_LA_112: % (aplicar antes 101 y 111)', v_faltan;
  END IF;

  FOR f IN SELECT * FROM (VALUES
      ('flujo_rol()',                                                    'e91f3124fb8422c0c79d56a184dcee49'),
      ('flujo_app(text)',                                                '6e3bd37fff5a476099e6951d40f13697'),
      ('flujo_solicitudes_pagina(uuid,text,text,uuid,text,integer,integer)', '0a79837ead37801b2cb2725c1577bb90'),
      ('solicitud_crear(text,text,text,jsonb,text)',                     '116a99b3441f193be2d7bddf38a330cd'),
      ('solicitud_cancelar(uuid)',                                       '92caa97310af7a39c6734667ea40afbf'),
      ('mis_solicitudes(text,text,integer,integer)',                     '9deb52e55c17e0d975f3e7eb45630798'),
      ('gerencia_solicitudes_conteo()',                                  '3e5cbe9efff2a46adf68cf6eda5b870a')
    ) AS v(firma, huella)
  LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || f.firma);
    IF position('112_tecnica_solicitudes' IN v_src) = 0
       AND md5(regexp_replace(v_src, '\s', '', 'g')) <> f.huella THEN
      RAISE EXCEPTION 'HUELLA_DISTINTA: public.% no es la del repo (md5 vivo %, esperado %). La base real se desvía: NO aplicar la 112 hasta revisarla.',
        f.firma, md5(regexp_replace(v_src, '\s', '', 'g')), f.huella;
    END IF;
  END LOOP;

  -- La auditoría debe aceptar app = 'tecnica' (099; ya lo exige la 111).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = 'public.erp_audit_events'::regclass AND c.contype = 'c'
                    AND pg_get_constraintdef(c.oid) LIKE '%''tecnica''%') THEN
    RAISE EXCEPTION 'AUDITORIA_SIN_APP_TECNICA: erp_audit_events no admite app = ''tecnica'' (la 099 vigente sí); no se aplica la 112.';
  END IF;
END
$$;

-- ============================================================
-- 1. Tipo nuevo 'presupuesto' en el CHECK de gerencia_solicitudes.kind
--    (se reemplaza la restricción conservando los 6 tipos de antes)
-- ============================================================
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT con.conname, pg_get_constraintdef(con.oid) AS def
             FROM pg_constraint con
            WHERE con.conrelid = 'public.gerencia_solicitudes'::regclass AND con.contype = 'c'
              AND pg_get_constraintdef(con.oid) LIKE '%validacion_abono%'
  LOOP
    IF c.def NOT LIKE '%presupuesto%' THEN
      EXECUTE format('ALTER TABLE public.gerencia_solicitudes DROP CONSTRAINT %I', c.conname);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint con
                  WHERE con.conrelid = 'public.gerencia_solicitudes'::regclass AND con.contype = 'c'
                    AND pg_get_constraintdef(con.oid) LIKE '%presupuesto%') THEN
    ALTER TABLE public.gerencia_solicitudes
      ADD CONSTRAINT gerencia_solicitudes_kind_check
      CHECK (kind IN ('validacion_abono', 'carta_no_adeudo', 'promocion', 'compra_obra', 'modificacion_plan', 'otro', 'presupuesto'));
  END IF;
END
$$;

-- ============================================================
-- 2. Ayudantes internos (flujo_rol, flujo_app, flujo_solicitudes_pagina)
-- ============================================================
-- Rol de quien llama: 'gerencia' si is_owner_or_gerencia; si no su área (administracion, cobranzas,
-- contabilidad, legal); si es miembro operativo del área técnica, 'tecnica'; si no ventas/marketing; si no NULL.
CREATE OR REPLACE FUNCTION public.flujo_rol()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  -- 112_tecnica_solicitudes
  SELECT CASE
           WHEN p.account_id IS NULL THEN NULL
           WHEN public.is_owner_or_gerencia(p.account_id) THEN 'gerencia'
           WHEN p.area IN ('administracion', 'cobranzas', 'contabilidad', 'legal') THEN p.area
           WHEN public.tecnica_rol_operativo_of(p.account_id, auth.uid()) IS NOT NULL THEN 'tecnica'
           WHEN p.area IN ('ventas', 'marketing') THEN p.area
           ELSE NULL
         END
    FROM public.profiles p WHERE p.user_id = auth.uid();
$$;

-- App de erp_audit_log que corresponde a un rol.
CREATE OR REPLACE FUNCTION public.flujo_app(p_rol text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  -- 112_tecnica_solicitudes
  SELECT CASE p_rol
           WHEN 'gerencia' THEN 'gerencia'
           WHEN 'administracion' THEN 'administracion'
           WHEN 'cobranzas' THEN 'cobranzas'
           WHEN 'legal' THEN 'legal'
           WHEN 'tecnica' THEN 'tecnica'
           WHEN 'contabilidad' THEN 'caja'
           ELSE 'golden_app'
         END;
$$;

-- Página de solicitudes en el formato del contrato. p_user + p_area (si vienen) = "las mías o de mi área".
CREATE OR REPLACE FUNCTION public.flujo_solicitudes_pagina(
  p_cuenta uuid, p_estado text, p_kind text, p_user uuid, p_area text, p_limit integer, p_offset integer)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  -- 112_tecnica_solicitudes
  v_total integer;
  v_items jsonb;
  v_lim   integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_off   integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF p_estado IS NOT NULL AND p_estado NOT IN ('pendiente', 'aprobada', 'rechazada', 'delegada', 'cancelada') THEN
    RAISE EXCEPTION 'Estado no válido' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NOT NULL AND p_kind NOT IN ('validacion_abono', 'carta_no_adeudo', 'promocion', 'compra_obra', 'modificacion_plan', 'otro', 'presupuesto') THEN
    RAISE EXCEPTION 'Tipo de solicitud no válido' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_total FROM public.gerencia_solicitudes s
   WHERE s.account_id = p_cuenta
     AND (p_estado IS NULL OR s.estado = p_estado)
     AND (p_kind IS NULL OR s.kind = p_kind)
     AND (p_user IS NULL OR s.solicitado_por = p_user OR s.solicitado_area = p_area);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', t.id, 'kind', t.kind, 'estado', t.estado, 'entity_type', t.entity_type, 'entity_id', t.entity_id,
           'resumen', t.resumen, 'nota', t.nota, 'solicitado_por_nombre', t.solicitado_por_nombre,
           'solicitado_area', t.solicitado_area, 'created_at', t.created_at,
           'resuelta_por_nombre', t.resuelta_por_nombre, 'resuelta_at', t.resuelta_at,
           'nota_resolucion', t.nota_resolucion, 'delegacion_id', t.delegacion_id)
         ORDER BY t.created_at DESC, t.id), '[]'::jsonb)
    INTO v_items
    FROM (SELECT s.* FROM public.gerencia_solicitudes s
           WHERE s.account_id = p_cuenta
             AND (p_estado IS NULL OR s.estado = p_estado)
             AND (p_kind IS NULL OR s.kind = p_kind)
             AND (p_user IS NULL OR s.solicitado_por = p_user OR s.solicitado_area = p_area)
           ORDER BY s.created_at DESC, s.id
           LIMIT v_lim OFFSET v_off) t;
  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END;
$$;

-- Ningún ayudante queda publicado.
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.flujo_rol()', 'public.flujo_app(text)',
    'public.flujo_solicitudes_pagina(uuid,text,text,uuid,text,integer,integer)']
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
END
$$;

-- ============================================================
-- 3. Solicitudes
-- ============================================================
CREATE OR REPLACE FUNCTION public.solicitud_crear(
  p_kind text, p_entity_type text, p_entity_id text, p_resumen jsonb, p_nota text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  -- 112_tecnica_solicitudes
  v_rol text;
  v_ok  text[];
  v_id  uuid;
BEGIN
  v_rol := public.flujo_exigir(ARRAY['gerencia', 'cobranzas', 'administracion', 'contabilidad', 'tecnica'],
                               'Tu área no puede crear solicitudes');
  IF p_kind IS NULL OR p_kind NOT IN ('validacion_abono', 'carta_no_adeudo', 'promocion', 'compra_obra', 'modificacion_plan', 'otro', 'presupuesto') THEN
    RAISE EXCEPTION 'Tipo de solicitud no válido' USING ERRCODE = '22023';
  END IF;
  v_ok := CASE v_rol
            WHEN 'gerencia' THEN ARRAY['validacion_abono', 'carta_no_adeudo', 'promocion', 'compra_obra', 'modificacion_plan', 'otro', 'presupuesto']
            WHEN 'cobranzas' THEN ARRAY['validacion_abono', 'carta_no_adeudo', 'promocion', 'modificacion_plan']
            WHEN 'administracion' THEN ARRAY['validacion_abono', 'compra_obra', 'otro']
            WHEN 'contabilidad' THEN ARRAY['otro']
            WHEN 'tecnica' THEN ARRAY['presupuesto', 'compra_obra', 'otro']
            ELSE ARRAY[]::text[]
          END;
  IF NOT (p_kind = ANY (v_ok)) THEN
    RAISE EXCEPTION 'Tu área no puede crear solicitudes de este tipo' USING ERRCODE = '42501';
  END IF;
  SELECT i.sol_id INTO v_id FROM public.flujo_solicitud_insertar(p_kind, p_entity_type, p_entity_id, p_resumen, p_nota) i;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.solicitud_cancelar(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  -- 112_tecnica_solicitudes
  s public.gerencia_solicitudes;
  v_rol text;
BEGIN
  v_rol := public.flujo_exigir(ARRAY['gerencia', 'cobranzas', 'administracion', 'contabilidad', 'tecnica', 'legal', 'ventas', 'marketing'],
                               'Sin permiso');
  SELECT * INTO s FROM public.gerencia_solicitudes x
   WHERE x.id = p_id AND x.account_id = public.flujo_cuenta() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Solicitud no encontrada' USING ERRCODE = '22023';
  END IF;
  IF s.solicitado_por IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Solo quien creó la solicitud puede cancelarla' USING ERRCODE = '42501';
  END IF;
  IF s.estado <> 'pendiente' THEN
    RAISE EXCEPTION 'Solo se cancela una solicitud pendiente (estado: %)', s.estado USING ERRCODE = '22023';
  END IF;
  UPDATE public.gerencia_solicitudes SET estado = 'cancelada', resuelta_at = now(),
         resuelta_por = auth.uid(), resuelta_por_nombre = public.flujo_nombre()
   WHERE id = p_id;
  -- Una promoción que se cancela vuelve a borrador (solo existe si se aplicó la 102).
  IF s.kind = 'promocion' AND s.entity_type = 'promocion' AND s.entity_id ~ '^[0-9a-fA-F-]{36}$'
     AND to_regprocedure('public.promocion_aplicar_cancelacion(uuid)') IS NOT NULL THEN
    EXECUTE 'SELECT public.promocion_aplicar_cancelacion($1)' USING s.entity_id::uuid;
  END IF;
  PERFORM public.flujo_audit(public.flujo_app(v_rol), 'anulo', 'solicitud', p_id::text,
    jsonb_build_object('kind', s.kind, 'entity_type', s.entity_type, 'entity_id', s.entity_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.mis_solicitudes(
  p_kind text DEFAULT NULL, p_estado text DEFAULT NULL, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  -- 112_tecnica_solicitudes
  v_rol text;
BEGIN
  v_rol := public.flujo_exigir(ARRAY['gerencia', 'cobranzas', 'administracion', 'contabilidad', 'tecnica', 'legal', 'ventas', 'marketing'],
                               'Sin permiso');
  RETURN public.flujo_solicitudes_pagina(public.flujo_cuenta(), p_estado, p_kind, auth.uid(), v_rol, p_limit, p_offset);
END;
$$;

CREATE OR REPLACE FUNCTION public.gerencia_solicitudes_conteo()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  -- 112_tecnica_solicitudes
  v_cuenta uuid;
BEGIN
  PERFORM public.flujo_exigir(ARRAY['gerencia'], 'Solo gerencia');
  v_cuenta := public.flujo_cuenta();
  RETURN jsonb_build_object(
    'pendientes', (SELECT count(*) FROM public.gerencia_solicitudes s WHERE s.account_id = v_cuenta AND s.estado = 'pendiente'),
    'por_kind', (SELECT jsonb_object_agg(k.kind, (SELECT count(*) FROM public.gerencia_solicitudes s
                                                    WHERE s.account_id = v_cuenta AND s.estado = 'pendiente' AND s.kind = k.kind))
                   FROM unnest(ARRAY['validacion_abono', 'carta_no_adeudo', 'promocion', 'compra_obra', 'modificacion_plan', 'otro', 'presupuesto']) AS k(kind)));
END;
$$;

-- ============================================================
-- 4. Permisos de las funciones publicadas
-- ============================================================
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.solicitud_crear(text,text,text,jsonb,text)',
    'public.solicitud_cancelar(uuid)',
    'public.mis_solicitudes(text,text,integer,integer)',
    'public.gerencia_solicitudes_conteo()']
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END
$$;

COMMIT;
