-- ============================================================
-- 111_tecnica.sql — Base de la app Técnica Golden (área técnica de Golden Habitat)
-- WIO_CRM main, por PR (main protegido). Correr en el SQL Editor de wioCRM (WioSuite).
--
-- Fuente: contrato "Técnica Golden (Fase 6)" del 2026-11-24, con lo que contó Celeste
-- en la revisión del 2026-11-21 (versión 1; lo que conteste Rubí entra en la versión 2).
--
-- Flujo que modela: el equipo técnico (Rubí jefa, Jennifer, Joaquín, Gabriela, Pio y el
-- topógrafo externo) pide materiales. Todo pasa por la jefa; lo aprueba gerencia
-- (Leandro); la jefa designa quién compra; queda quién compró y, si hubo mala gestión,
-- quién fue y cuánto se perdió. Además: almacén de materiales y herramientas prestadas,
-- y las fichas técnicas y planos (las hace técnica y las firma la jefa; administración
-- las exige en la lista de verificación del contrato, 110, cuando es casa).
--
-- SOLO AGREGA objetos nuevos (todos con prefijo tecnica_); no reemplaza ninguna función
-- existente. Crea:
--   1. tecnica_members: quién es jefe o equipo (account_id, user_id, role).
--   2. Roles: tecnica_role_of (interna), tecnica_role(cuenta) y tecnica_my_access().
--        gerencia = dueño o área gerencia (is_owner_or_gerencia): aprueba y rechaza.
--        jefe     = fila 'jefe' en tecnica_members: revisa, envía, asigna, cierra, firma.
--        equipo   = fila 'equipo' o perfil con area = 'tecnica'.
--        lectura  = área administración o contabilidad: ve, no cambia nada.
--        NULL     = cualquier otro. Mismo candado de miembro activo que marketing_role_of
--        (096): cuenta activa, sin clientes viewer ni área promueve.
--   3. Tablas: tecnica_solicitudes, tecnica_solicitud_items, tecnica_compras,
--      tecnica_almacen_movimientos y tecnica_fichas. Con RLS y SIN política ni GRANT:
--      nadie lee ni escribe directo, todo va por las funciones de abajo.
--   4. Bucket privado 'tecnica' en Storage (15 MB) y sus políticas.
--   5. Funciones para la app (todas SECURITY DEFINER, validan el rol y dejan huella en
--      erp_audit_events con app = 'tecnica'): pedidos, compras, almacén y fichas.
--
-- Cuenta implícita: las funciones toman la cuenta del perfil de quien llama (auth.uid()).
-- La única que recibe la cuenta es tecnica_equipo(p_account) y tecnica_role(p_account).
--
-- Decisiones que el contrato no cerraba (versión 1, 2026-11-24):
--   - Stock = ingresos − salidas + devoluciones, y las salidas en préstamo SÍ restan
--     (la herramienta prestada no está en el almacén); al devolverla vuelve a sumar.
--     Los préstamos abiertos se listan aparte.
--   - El gasto de un mes es la suma de tecnica_compras.monto cuya compra se registró en
--     ese mes (hora de Lima); el vuelto se guarda aparte y no se resta. Las pérdidas del
--     mes son las de los pedidos cerrados en ese mes.
--   - Las funciones de lista devuelven un objeto {total, <lista>} (el total es antes del
--     tope), no un arreglo suelto.
--   - Las acciones de erp_audit_events solo admiten creo/edito/aprobo/rechazo/delego/anulo
--     (099): cerrar y registrar compra quedan como 'edito', firmar como 'aprobo',
--     asignar como 'delego'; el detalle dice qué fue.
--
-- Requiere (la migración se detiene con un mensaje claro si falta algo): 084
-- (is_owner_or_gerencia), 085/089/092 (área 'tecnica' en profiles) y 099 (erp_audit_log y
-- erp_audit_events con app 'tecnica'). La ficha usa gh_lotes_solicitudes (098) SOLO si
-- existe: con la tabla presente agrega la llave foránea, si no, la columna queda sin FK.
--
-- ANTES de aplicar, comprobar a mano que las funciones vivas son las del repo (la
-- migración lo comprueba sola, esto es para verlo antes de correrla). La huella es el
-- md5 del cuerpo SIN espacios ni saltos de línea (así no importa CRLF/LF):
--   SELECT p.proname, md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p
--    WHERE p.pronamespace = 'public'::regnamespace
--      AND p.proname IN ('is_owner_or_gerencia', 'erp_audit_log');
--   Deben salir:
--     is_owner_or_gerencia  ee5ad9e93e785841acafb8c530688bc5  (084)
--     erp_audit_log         ffc884bb56d549392ef69573d600cb11  (099)
--   Si no coinciden, NO aplicar: la base real se desvía del repo.
--
-- Casos: CRM WIO\traspaso-catalogo\probar-111.mjs (PGlite).
-- Idempotente — se puede volver a correr.
-- ============================================================
BEGIN;

-- ============================================================
-- 0. Guardas: lo que debe existir y huella de lo que se reutiliza
-- ============================================================
DO $$
DECLARE
  f record;
  v_src text;
  v_faltan text;
BEGIN
  SELECT string_agg(t, ', ') INTO v_faltan
    FROM unnest(ARRAY['public.accounts', 'public.profiles', 'public.real_estate_projects',
                      'public.erp_audit_events', 'storage.buckets', 'storage.objects']) AS t
   WHERE to_regclass(t) IS NULL;
  IF v_faltan IS NOT NULL THEN
    RAISE EXCEPTION 'FALTAN_TABLAS_PARA_LA_111: % (aplicar antes la 099 de auditoría y revisar que Storage esté activo)', v_faltan;
  END IF;

  SELECT string_agg(t, ', ') INTO v_faltan
    FROM unnest(ARRAY['is_owner_or_gerencia(uuid)', 'erp_audit_log(text,text,text,text,jsonb)']) AS t
   WHERE to_regprocedure('public.' || t) IS NULL;
  IF v_faltan IS NOT NULL THEN
    RAISE EXCEPTION 'FALTAN_FUNCIONES_PARA_LA_111: % (aplicar antes 084 y 099)', v_faltan;
  END IF;

  FOR f IN SELECT * FROM (VALUES
      ('is_owner_or_gerencia(uuid)',                    'ee5ad9e93e785841acafb8c530688bc5'),
      ('erp_audit_log(text,text,text,text,jsonb)',      'ffc884bb56d549392ef69573d600cb11')
    ) AS v(firma, huella)
  LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || f.firma);
    IF md5(regexp_replace(v_src, '\s', '', 'g')) <> f.huella THEN
      RAISE EXCEPTION 'HUELLA_DISTINTA: public.% no es la del repo (md5 vivo %, esperado %). La base real se desvía: NO aplicar la 111 hasta revisarla.',
        f.firma, md5(regexp_replace(v_src, '\s', '', 'g')), f.huella;
    END IF;
  END LOOP;

  -- La auditoría debe aceptar app = 'tecnica' (099).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = 'public.erp_audit_events'::regclass AND c.contype = 'c'
                    AND pg_get_constraintdef(c.oid) LIKE '%''tecnica''%') THEN
    RAISE EXCEPTION 'AUDITORIA_SIN_APP_TECNICA: erp_audit_events no admite app = ''tecnica'' (la 099 vigente sí); no se aplica la 111.';
  END IF;

  -- El área 'tecnica' debe existir en profiles (085/089/092).
  IF EXISTS (SELECT 1 FROM pg_constraint c
              WHERE c.conrelid = 'public.profiles'::regclass AND c.conname = 'profiles_area_check')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint c
                      WHERE c.conrelid = 'public.profiles'::regclass AND c.conname = 'profiles_area_check'
                        AND pg_get_constraintdef(c.oid) LIKE '%''tecnica''%') THEN
    RAISE EXCEPTION 'AREA_TECNICA_NO_EXISTE: profiles_area_check no admite el área ''tecnica'' (aplicar antes 085, 089 y 092).';
  END IF;
END
$$;

-- ============================================================
-- 1. Miembros del área técnica
-- ============================================================
CREATE TABLE IF NOT EXISTS public.tecnica_members (
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('jefe', 'equipo')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);
ALTER TABLE public.tecnica_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tecnica_members FROM PUBLIC, anon, authenticated;
-- Sin políticas y sin GRANT: se llena con el SQL de alta (alta-tecnica-golden) y se lee con tecnica_equipo().

-- ============================================================
-- 2. Tablas
-- ============================================================
CREATE TABLE IF NOT EXISTS public.tecnica_solicitudes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  numero            integer NOT NULL CHECK (numero > 0),
  obra              text NOT NULL CHECK (char_length(btrim(obra)) BETWEEN 1 AND 120),
  project_id        uuid REFERENCES public.real_estate_projects(id) ON DELETE SET NULL,
  titulo            text CHECK (titulo IS NULL OR char_length(titulo) <= 140),
  nota              text CHECK (nota IS NULL OR char_length(nota) <= 500),
  urgente           boolean NOT NULL DEFAULT false,
  necesita_para     date,
  monto_estimado    numeric CHECK (monto_estimado IS NULL OR monto_estimado >= 0),
  estado            text NOT NULL DEFAULT 'pedida'
                      CHECK (estado IN ('pedida', 'por_aprobar', 'aprobada', 'asignada', 'comprada', 'cerrada', 'rechazada', 'anulada')),
  solicitado_por    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  revisado_por      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  revisado_at       timestamptz,
  aprobado_por      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  aprobado_at       timestamptz,
  rechazado_por     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  rechazado_at      timestamptz,
  motivo_rechazo    text CHECK (motivo_rechazo IS NULL OR char_length(motivo_rechazo) <= 500),
  comprador_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  asignado_por      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  asignado_at       timestamptz,
  cerrado_por       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cerrado_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tecnica_solicitudes_numero_unico UNIQUE (account_id, numero),
  CONSTRAINT tecnica_solicitudes_rechazo_con_motivo CHECK (estado <> 'rechazada' OR motivo_rechazo IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS tecnica_solicitudes_cuenta_estado ON public.tecnica_solicitudes (account_id, estado);
CREATE INDEX IF NOT EXISTS tecnica_solicitudes_cuenta_fecha ON public.tecnica_solicitudes (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.tecnica_solicitud_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitud_id     uuid NOT NULL REFERENCES public.tecnica_solicitudes(id) ON DELETE CASCADE,
  orden            integer NOT NULL DEFAULT 1,
  descripcion      text NOT NULL CHECK (char_length(btrim(descripcion)) BETWEEN 1 AND 200),
  cantidad         numeric NOT NULL CHECK (cantidad > 0),
  unidad           text NOT NULL DEFAULT 'unidad' CHECK (unidad IN ('bolsa', 'unidad', 'm', 'kg', 'galón', 'otro')),
  precio_estimado  numeric CHECK (precio_estimado IS NULL OR precio_estimado >= 0)
);
CREATE INDEX IF NOT EXISTS tecnica_solicitud_items_solicitud ON public.tecnica_solicitud_items (solicitud_id, orden);

CREATE TABLE IF NOT EXISTS public.tecnica_compras (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitud_id         uuid NOT NULL UNIQUE REFERENCES public.tecnica_solicitudes(id) ON DELETE CASCADE,
  comprador_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  monto                numeric NOT NULL CHECK (monto >= 0),
  proveedor            text CHECK (proveedor IS NULL OR char_length(proveedor) <= 120),
  comprobante_tipo     text NOT NULL CHECK (comprobante_tipo IN ('boleta', 'factura', 'ticket', 'sin_comprobante')),
  comprobante_numero   text CHECK (comprobante_numero IS NULL OR char_length(comprobante_numero) <= 60),
  comprobante_path     text CHECK (comprobante_path IS NULL OR char_length(comprobante_path) <= 300),
  vuelto               numeric NOT NULL DEFAULT 0 CHECK (vuelto >= 0),
  nota                 text CHECK (nota IS NULL OR char_length(nota) <= 500),
  registrada_por       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  registrada_at        timestamptz NOT NULL DEFAULT now(),
  actualizada_por      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actualizada_at       timestamptz,
  -- Al cerrar el pedido:
  perdida              numeric NOT NULL DEFAULT 0 CHECK (perdida >= 0),
  perdida_motivo       text CHECK (perdida_motivo IS NULL OR char_length(perdida_motivo) <= 500),
  perdida_responsable  uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS tecnica_compras_registrada ON public.tecnica_compras (registrada_at);

CREATE TABLE IF NOT EXISTS public.tecnica_almacen_movimientos (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  tipo                text NOT NULL CHECK (tipo IN ('ingreso', 'salida', 'devolucion')),
  material            text NOT NULL CHECK (char_length(btrim(material)) BETWEEN 1 AND 160),
  cantidad            numeric NOT NULL CHECK (cantidad > 0),
  unidad              text NOT NULL DEFAULT 'unidad' CHECK (char_length(btrim(unidad)) BETWEEN 1 AND 30),
  obra                text CHECK (obra IS NULL OR char_length(obra) <= 120),
  es_prestamo         boolean NOT NULL DEFAULT false,
  responsable_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  responsable_nombre  text CHECK (responsable_nombre IS NULL OR char_length(responsable_nombre) <= 120),
  devolver_antes      date,
  devuelto_at         timestamptz,
  movimiento_origen   uuid REFERENCES public.tecnica_almacen_movimientos(id) ON DELETE SET NULL,
  solicitud_id        uuid REFERENCES public.tecnica_solicitudes(id) ON DELETE SET NULL,
  nota                text CHECK (nota IS NULL OR char_length(nota) <= 500),
  registrado_por      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Solo una salida puede ser préstamo; devuelto_at y devolver_antes solo de préstamos.
  CONSTRAINT tecnica_almacen_prestamo_solo_salida CHECK (NOT es_prestamo OR tipo = 'salida'),
  CONSTRAINT tecnica_almacen_devuelto_solo_prestamo CHECK ((devuelto_at IS NULL AND devolver_antes IS NULL) OR es_prestamo),
  CONSTRAINT tecnica_almacen_origen_solo_devolucion CHECK (movimiento_origen IS NULL OR tipo = 'devolucion')
);
CREATE INDEX IF NOT EXISTS tecnica_almacen_cuenta_fecha ON public.tecnica_almacen_movimientos (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tecnica_almacen_prestamos_abiertos ON public.tecnica_almacen_movimientos (account_id, devolver_antes)
  WHERE es_prestamo AND devuelto_at IS NULL;

CREATE TABLE IF NOT EXISTS public.tecnica_fichas (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  tipo                  text NOT NULL CHECK (tipo IN ('ficha_tecnica', 'plano', 'plano_ubicacion', 'otro')),
  titulo                text NOT NULL CHECK (char_length(btrim(titulo)) BETWEEN 1 AND 140),
  project_id            uuid REFERENCES public.real_estate_projects(id) ON DELETE SET NULL,
  ubicacion             text CHECK (ubicacion IS NULL OR char_length(ubicacion) <= 120),
  cliente_nombre        text CHECK (cliente_nombre IS NULL OR char_length(cliente_nombre) <= 120),
  contrato_solicitud_id uuid,
  archivo_path          text NOT NULL CHECK (char_length(archivo_path) BETWEEN 1 AND 300),
  estado                text NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'firmada')),
  firmada_por           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  firmada_at            timestamptz,
  subida_por            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tecnica_fichas_firma_con_fecha CHECK (estado <> 'firmada' OR firmada_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS tecnica_fichas_cuenta_fecha ON public.tecnica_fichas (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tecnica_fichas_contrato ON public.tecnica_fichas (contrato_solicitud_id) WHERE contrato_solicitud_id IS NOT NULL;

-- La ficha apunta a la separación de la Golden App (098) solo si esa tabla existe en esta base.
DO $$
BEGIN
  IF to_regclass('public.gh_lotes_solicitudes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conrelid = 'public.tecnica_fichas'::regclass AND conname = 'tecnica_fichas_contrato_fk') THEN
    ALTER TABLE public.tecnica_fichas
      ADD CONSTRAINT tecnica_fichas_contrato_fk FOREIGN KEY (contrato_solicitud_id)
      REFERENCES public.gh_lotes_solicitudes(id) ON DELETE SET NULL;
  END IF;
END
$$;

ALTER TABLE public.tecnica_solicitudes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tecnica_solicitud_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tecnica_compras             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tecnica_almacen_movimientos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tecnica_fichas              ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tecnica_solicitudes, public.tecnica_solicitud_items, public.tecnica_compras,
              public.tecnica_almacen_movimientos, public.tecnica_fichas FROM PUBLIC, anon, authenticated;
-- Sin políticas y sin GRANT: nadie lee ni escribe directo (todo va por funciones).

-- ============================================================
-- 3. Roles
-- ============================================================
-- Rol operativo (jefe o equipo) de un usuario, SIN contar gerencia. Interna.
-- Mismo candado de miembro activo que marketing_role_of (096): cuenta activa, sin viewer ni promueve.
CREATE OR REPLACE FUNCTION public.tecnica_rol_operativo_of(p_account uuid, p_user uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_account IS NULL OR p_user IS NULL THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM public.profiles p JOIN public.accounts ac ON ac.id = p.account_id
                      WHERE p.user_id = p_user AND p.account_id = p_account AND ac.status = 'active'
                        AND p.account_role <> 'viewer' AND COALESCE(p.area, '') <> 'promueve') THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.tecnica_members m
                  WHERE m.account_id = p_account AND m.user_id = p_user AND m.role = 'jefe') THEN 'jefe'
    WHEN EXISTS (SELECT 1 FROM public.tecnica_members m
                  WHERE m.account_id = p_account AND m.user_id = p_user AND m.role = 'equipo')
      OR EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.user_id = p_user AND p.account_id = p_account AND p.area = 'tecnica') THEN 'equipo'
    ELSE NULL
  END;
$$;

-- Rol completo de un usuario concreto (uso interno: no se concede a authenticated para
-- que nadie consulte el rol de otras personas).
CREATE OR REPLACE FUNCTION public.tecnica_role_of(p_account uuid, p_user uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_account IS NULL OR p_user IS NULL THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM public.profiles p JOIN public.accounts ac ON ac.id = p.account_id
                      WHERE p.user_id = p_user AND p.account_id = p_account AND ac.status = 'active'
                        AND p.account_role <> 'viewer' AND COALESCE(p.area, '') <> 'promueve') THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.user_id = p_user AND p.account_id = p_account
                    AND (p.account_role = 'owner' OR p.area = 'gerencia')) THEN 'gerencia'
    ELSE COALESCE(
      public.tecnica_rol_operativo_of(p_account, p_user),
      CASE WHEN EXISTS (SELECT 1 FROM public.profiles p
                         WHERE p.user_id = p_user AND p.account_id = p_account
                           AND p.area IN ('administracion', 'contabilidad')) THEN 'lectura' END)
  END;
$$;

CREATE OR REPLACE FUNCTION public.tecnica_role(p_account uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL OR p_account IS NULL THEN NULL
    WHEN public.is_owner_or_gerencia(p_account) THEN 'gerencia'
    ELSE public.tecnica_role_of(p_account, auth.uid())
  END;
$$;

CREATE OR REPLACE FUNCTION public.tecnica_my_access()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  RETURN jsonb_build_object('account_id', a, 'role', public.tecnica_role(a), 'user_id', auth.uid());
END;
$$;

-- ============================================================
-- 4. Ayudantes internos (nadie con sesión los llama)
-- ============================================================
CREATE OR REPLACE FUNCTION public.tecnica_cuenta()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.account_id FROM public.profiles p WHERE p.user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.tecnica_nombre(p_user uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), p.email) FROM public.profiles p WHERE p.user_id = p_user;
$$;

-- Cuenta y rol de quien llama; si el rol no está en la lista, 42501 con el mensaje dado.
CREATE OR REPLACE FUNCTION public.tecnica_exigir(p_roles text[], p_mensaje text)
RETURNS TABLE (cuenta uuid, rol text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid := public.tecnica_cuenta();
  r text := public.tecnica_role(a);
BEGIN
  IF auth.uid() IS NULL OR a IS NULL OR r IS NULL OR NOT (r = ANY (p_roles)) THEN
    RAISE EXCEPTION '%', p_mensaje USING ERRCODE = '42501';
  END IF;
  cuenta := a;
  rol := r;
  RETURN NEXT;
END;
$$;

-- Texto libre limpio: recorta y valida el largo. Devuelve NULL si viene vacío y p_min = 0.
CREATE OR REPLACE FUNCTION public.tecnica_texto(p_texto text, p_campo text, p_min integer, p_max integer)
RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v text := btrim(COALESCE(p_texto, ''));
BEGIN
  IF v = '' AND p_min = 0 THEN
    RETURN NULL;
  END IF;
  IF length(v) < p_min THEN
    IF p_min = 1 THEN
      RAISE EXCEPTION '% es obligatorio', p_campo USING ERRCODE = '22023';
    END IF;
    RAISE EXCEPTION '% debe tener al menos % caracteres', p_campo, p_min USING ERRCODE = '22023';
  END IF;
  IF length(v) > p_max THEN
    RAISE EXCEPTION '% no puede pasar de % caracteres', p_campo, p_max USING ERRCODE = '22023';
  END IF;
  RETURN v;
END;
$$;

-- Unidad de un ítem de pedido: bolsa, unidad, m, kg, galón u otro (vacío = unidad).
CREATE OR REPLACE FUNCTION public.tecnica_unidad_item(p_unidad text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v text := lower(btrim(COALESCE(p_unidad, '')));
BEGIN
  IF v = '' THEN RETURN 'unidad'; END IF;
  IF v IN ('galon', 'galones', 'galón') THEN v := 'galón'; END IF;
  IF v NOT IN ('bolsa', 'unidad', 'm', 'kg', 'galón', 'otro') THEN
    RAISE EXCEPTION 'La unidad debe ser bolsa, unidad, m, kg, galón u otro' USING ERRCODE = '22023';
  END IF;
  RETURN v;
END;
$$;

-- Huella en erp_audit_events (app 'tecnica'). Las acciones válidas son las de la 099.
CREATE OR REPLACE FUNCTION public.tecnica_audit(p_accion text, p_entity_type text, p_entity_id text, p_detail jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.erp_audit_log('tecnica', p_accion, p_entity_type, p_entity_id, COALESCE(p_detail, '{}'::jsonb));
END;
$$;

-- Hoy en Lima.
CREATE OR REPLACE FUNCTION public.tecnica_hoy()
RETURNS date
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT (now() AT TIME ZONE 'America/Lima')::date;
$$;

-- Quien puede leer fichas: cualquier rol técnico o de lectura, y además legal (lista de verificación del contrato).
CREATE OR REPLACE FUNCTION public.tecnica_ficha_lector()
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid := public.tecnica_cuenta();
BEGIN
  IF auth.uid() IS NULL OR a IS NULL THEN
    RAISE EXCEPTION 'Sin permiso para ver las fichas' USING ERRCODE = '42501';
  END IF;
  IF public.tecnica_role(a) IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.profiles p JOIN public.accounts ac ON ac.id = p.account_id
                 WHERE p.user_id = auth.uid() AND p.account_id = a AND ac.status = 'active'
                   AND p.account_role <> 'viewer' AND p.area = 'legal') THEN
    RETURN a;
  END IF;
  RAISE EXCEPTION 'Sin permiso para ver las fichas' USING ERRCODE = '42501';
END;
$$;

-- ============================================================
-- 5. Equipo técnico (selector de comprador)
-- ============================================================
CREATE OR REPLACE FUNCTION public.tecnica_equipo(p_account uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid := COALESCE(p_account, public.tecnica_cuenta());
BEGIN
  IF auth.uid() IS NULL OR a IS NULL OR public.tecnica_role(a) IS NULL
     OR public.tecnica_role(a) NOT IN ('jefe', 'gerencia') THEN
    RAISE EXCEPTION 'Solo la jefa técnica o gerencia ve el equipo' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('user_id', t.user_id, 'nombre', t.nombre, 'role', t.rol)
                     ORDER BY (t.rol <> 'jefe'), t.nombre)
      FROM (SELECT p.user_id, COALESCE(NULLIF(btrim(p.full_name), ''), p.email) AS nombre,
                   public.tecnica_rol_operativo_of(a, p.user_id) AS rol
              FROM public.profiles p WHERE p.account_id = a) t
     WHERE t.rol IS NOT NULL), '[]'::jsonb);
END;
$$;

-- ============================================================
-- 6. Pedidos
-- ============================================================
-- p_items: arreglo de {descripcion, cantidad, unidad, precio_estimado}. Devuelve el id.
CREATE OR REPLACE FUNCTION public.tecnica_pedido_crear(
  p_obra text, p_titulo text, p_items jsonb, p_urgente boolean DEFAULT false,
  p_necesita_para date DEFAULT NULL, p_project_id uuid DEFAULT NULL, p_nota text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_rol text;
  v_obra text;
  v_titulo text;
  v_nota text;
  v_id uuid := gen_random_uuid();
  v_num integer;
  v_estado text;
  it jsonb;
  n integer := 0;
  v_cant numeric;
  v_precio numeric;
  v_monto numeric := 0;
  v_hay_precio boolean := false;
BEGIN
  SELECT x.cuenta, x.rol INTO a, v_rol
    FROM public.tecnica_exigir(ARRAY['jefe', 'equipo', 'gerencia'], 'Solo el área técnica o gerencia crea pedidos') x;
  v_obra := public.tecnica_texto(p_obra, 'La obra', 1, 120);
  v_titulo := public.tecnica_texto(p_titulo, 'El título', 0, 140);
  v_nota := public.tecnica_texto(p_nota, 'La nota', 0, 500);
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'El pedido necesita al menos un ítem' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'Un pedido no puede pasar de 100 ítems' USING ERRCODE = '22023';
  END IF;
  IF p_project_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.real_estate_projects r WHERE r.id = p_project_id AND r.account_id = a) THEN
    RAISE EXCEPTION 'Proyecto no válido' USING ERRCODE = '22023';
  END IF;

  -- Correlativo por cuenta (el candado evita que dos pedidos simultáneos tomen el mismo número).
  PERFORM pg_advisory_xact_lock(hashtextextended('tecnica_solicitudes:' || a::text, 0));
  SELECT COALESCE(max(s.numero), 0) + 1 INTO v_num FROM public.tecnica_solicitudes s WHERE s.account_id = a;
  v_estado := CASE WHEN v_rol IN ('jefe', 'gerencia') THEN 'por_aprobar' ELSE 'pedida' END;

  INSERT INTO public.tecnica_solicitudes
    (id, account_id, numero, obra, project_id, titulo, nota, urgente, necesita_para, estado, solicitado_por,
     revisado_por, revisado_at)
  VALUES (v_id, a, v_num, v_obra, p_project_id, v_titulo, v_nota, COALESCE(p_urgente, false), p_necesita_para,
          v_estado, auth.uid(),
          CASE WHEN v_rol = 'jefe' THEN auth.uid() END, CASE WHEN v_rol = 'jefe' THEN now() END);

  FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    n := n + 1;
    IF jsonb_typeof(it) <> 'object' THEN
      RAISE EXCEPTION 'El ítem % no es válido', n USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(it -> 'cantidad') = 'number'
       OR (jsonb_typeof(it -> 'cantidad') = 'string' AND (it ->> 'cantidad') ~ '^[0-9]+(\.[0-9]+)?$') THEN
      v_cant := (it ->> 'cantidad')::numeric;
    ELSE
      RAISE EXCEPTION 'El ítem % necesita una cantidad mayor que cero', n USING ERRCODE = '22023';
    END IF;
    IF v_cant <= 0 THEN
      RAISE EXCEPTION 'El ítem % necesita una cantidad mayor que cero', n USING ERRCODE = '22023';
    END IF;
    IF it -> 'precio_estimado' IS NULL OR jsonb_typeof(it -> 'precio_estimado') = 'null' THEN
      v_precio := NULL;
    ELSIF jsonb_typeof(it -> 'precio_estimado') = 'number'
       OR (jsonb_typeof(it -> 'precio_estimado') = 'string' AND (it ->> 'precio_estimado') ~ '^[0-9]+(\.[0-9]+)?$') THEN
      v_precio := (it ->> 'precio_estimado')::numeric;
    ELSE
      RAISE EXCEPTION 'El precio estimado del ítem % no es válido', n USING ERRCODE = '22023';
    END IF;
    IF v_precio IS NOT NULL AND v_precio < 0 THEN
      RAISE EXCEPTION 'El precio estimado del ítem % no puede ser negativo', n USING ERRCODE = '22023';
    END IF;
    IF v_precio IS NOT NULL THEN
      v_hay_precio := true;
      v_monto := v_monto + v_cant * v_precio;
    END IF;
    INSERT INTO public.tecnica_solicitud_items (solicitud_id, orden, descripcion, cantidad, unidad, precio_estimado)
    VALUES (v_id, n, public.tecnica_texto(it ->> 'descripcion', 'La descripción del ítem ' || n, 1, 200),
            v_cant, public.tecnica_unidad_item(it ->> 'unidad'), v_precio);
  END LOOP;

  IF v_hay_precio THEN
    UPDATE public.tecnica_solicitudes SET monto_estimado = v_monto WHERE id = v_id;
  END IF;

  PERFORM public.tecnica_audit('creo', 'tecnica_pedido', v_id::text,
    jsonb_build_object('numero', v_num, 'obra', v_obra, 'items', n, 'estado', v_estado, 'urgente', COALESCE(p_urgente, false)));
  RETURN v_id;
END;
$$;

-- La jefa (o gerencia) envía a gerencia un pedido del equipo: pedida -> por_aprobar.
CREATE OR REPLACE FUNCTION public.tecnica_pedido_enviar(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  s public.tecnica_solicitudes;
BEGIN
  SELECT x.cuenta INTO a FROM public.tecnica_exigir(ARRAY['jefe', 'gerencia'], 'Solo la jefa técnica o gerencia envía pedidos a aprobar') x;
  SELECT * INTO s FROM public.tecnica_solicitudes WHERE id = p_id AND account_id = a FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido no encontrado' USING ERRCODE = 'P0002'; END IF;
  IF s.estado <> 'pedida' THEN
    RAISE EXCEPTION 'Solo se envía un pedido en estado pedida (este está %)', s.estado USING ERRCODE = '22023';
  END IF;
  UPDATE public.tecnica_solicitudes
     SET estado = 'por_aprobar', revisado_por = auth.uid(), revisado_at = now(), updated_at = now()
   WHERE id = p_id;
  PERFORM public.tecnica_audit('edito', 'tecnica_pedido', p_id::text,
    jsonb_build_object('numero', s.numero, 'paso', 'enviado_a_gerencia'));
END;
$$;

-- Solo gerencia: por_aprobar -> aprobada.
CREATE OR REPLACE FUNCTION public.tecnica_pedido_aprobar(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  s public.tecnica_solicitudes;
BEGIN
  SELECT x.cuenta INTO a FROM public.tecnica_exigir(ARRAY['gerencia'], 'Solo gerencia aprueba pedidos') x;
  SELECT * INTO s FROM public.tecnica_solicitudes WHERE id = p_id AND account_id = a FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido no encontrado' USING ERRCODE = 'P0002'; END IF;
  IF s.estado <> 'por_aprobar' THEN
    RAISE EXCEPTION 'Solo se aprueba un pedido por aprobar (este está %)', s.estado USING ERRCODE = '22023';
  END IF;
  UPDATE public.tecnica_solicitudes
     SET estado = 'aprobada', aprobado_por = auth.uid(), aprobado_at = now(), updated_at = now()
   WHERE id = p_id;
  PERFORM public.tecnica_audit('aprobo', 'tecnica_pedido', p_id::text,
    jsonb_build_object('numero', s.numero, 'monto_estimado', s.monto_estimado));
END;
$$;

-- Jefa: solo desde pedida. Gerencia: desde pedida, por_aprobar o aprobada. Motivo obligatorio.
CREATE OR REPLACE FUNCTION public.tecnica_pedido_rechazar(p_id uuid, p_motivo text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_rol text;
  s public.tecnica_solicitudes;
  v_motivo text;
BEGIN
  SELECT x.cuenta, x.rol INTO a, v_rol
    FROM public.tecnica_exigir(ARRAY['jefe', 'gerencia'], 'Solo la jefa técnica o gerencia rechaza pedidos') x;
  v_motivo := public.tecnica_texto(p_motivo, 'El motivo del rechazo', 1, 500);
  SELECT * INTO s FROM public.tecnica_solicitudes WHERE id = p_id AND account_id = a FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido no encontrado' USING ERRCODE = 'P0002'; END IF;
  IF v_rol = 'jefe' AND s.estado <> 'pedida' THEN
    RAISE EXCEPTION 'La jefa técnica solo rechaza pedidos aún no enviados a gerencia (este está %)', s.estado USING ERRCODE = '22023';
  END IF;
  IF s.estado NOT IN ('pedida', 'por_aprobar', 'aprobada') THEN
    RAISE EXCEPTION 'No se puede rechazar un pedido en estado %', s.estado USING ERRCODE = '22023';
  END IF;
  UPDATE public.tecnica_solicitudes
     SET estado = 'rechazada', rechazado_por = auth.uid(), rechazado_at = now(), motivo_rechazo = v_motivo, updated_at = now()
   WHERE id = p_id;
  PERFORM public.tecnica_audit('rechazo', 'tecnica_pedido', p_id::text,
    jsonb_build_object('numero', s.numero, 'estado_anterior', s.estado, 'motivo', v_motivo));
END;
$$;

-- Quien lo pidió, mientras esté pedida o por_aprobar.
CREATE OR REPLACE FUNCTION public.tecnica_pedido_anular(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  s public.tecnica_solicitudes;
BEGIN
  SELECT x.cuenta INTO a FROM public.tecnica_exigir(ARRAY['jefe', 'equipo', 'gerencia'], 'Solo el área técnica o gerencia anula pedidos') x;
  SELECT * INTO s FROM public.tecnica_solicitudes WHERE id = p_id AND account_id = a FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido no encontrado' USING ERRCODE = 'P0002'; END IF;
  IF s.solicitado_por IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Solo quien hizo el pedido lo puede anular' USING ERRCODE = '42501';
  END IF;
  IF s.estado NOT IN ('pedida', 'por_aprobar') THEN
    RAISE EXCEPTION 'Solo se anula un pedido pedido o por aprobar (este está %)', s.estado USING ERRCODE = '22023';
  END IF;
  UPDATE public.tecnica_solicitudes SET estado = 'anulada', updated_at = now() WHERE id = p_id;
  PERFORM public.tecnica_audit('anulo', 'tecnica_pedido', p_id::text,
    jsonb_build_object('numero', s.numero, 'estado_anterior', s.estado));
END;
$$;

-- La jefa o gerencia designa quién compra: aprobada o asignada -> asignada.
CREATE OR REPLACE FUNCTION public.tecnica_pedido_asignar(p_id uuid, p_comprador_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  s public.tecnica_solicitudes;
BEGIN
  SELECT x.cuenta INTO a FROM public.tecnica_exigir(ARRAY['jefe', 'gerencia'], 'Solo la jefa técnica o gerencia asigna quién compra') x;
  SELECT * INTO s FROM public.tecnica_solicitudes WHERE id = p_id AND account_id = a FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido no encontrado' USING ERRCODE = 'P0002'; END IF;
  IF s.estado NOT IN ('aprobada', 'asignada') THEN
    RAISE EXCEPTION 'Solo se asigna un pedido aprobado (este está %)', s.estado USING ERRCODE = '22023';
  END IF;
  IF p_comprador_id IS NULL OR public.tecnica_rol_operativo_of(a, p_comprador_id) IS NULL THEN
    RAISE EXCEPTION 'El comprador debe ser jefe o equipo del área técnica' USING ERRCODE = '22023';
  END IF;
  UPDATE public.tecnica_solicitudes
     SET estado = 'asignada', comprador_id = p_comprador_id, asignado_por = auth.uid(), asignado_at = now(), updated_at = now()
   WHERE id = p_id;
  PERFORM public.tecnica_audit('delego', 'tecnica_pedido', p_id::text,
    jsonb_build_object('numero', s.numero, 'comprador_id', p_comprador_id, 'comprador', public.tecnica_nombre(p_comprador_id)));
END;
$$;

-- El comprador asignado, la jefa o gerencia: asignada -> comprada. Se puede corregir mientras esté comprada.
-- p_comprobante_path debe ser {cuenta}/compras/{pedido}/archivo en el bucket 'tecnica'.
CREATE OR REPLACE FUNCTION public.tecnica_compra_registrar(
  p_id uuid, p_monto numeric, p_proveedor text, p_comprobante_tipo text, p_comprobante_numero text DEFAULT NULL,
  p_comprobante_path text DEFAULT NULL, p_vuelto numeric DEFAULT 0, p_nota text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_rol text;
  s public.tecnica_solicitudes;
  v_prov text;
  v_num text;
  v_nota text;
  v_path text := NULLIF(btrim(COALESCE(p_comprobante_path, '')), '');
  v_nueva boolean;
BEGIN
  SELECT x.cuenta, x.rol INTO a, v_rol
    FROM public.tecnica_exigir(ARRAY['jefe', 'equipo', 'gerencia'], 'Solo el comprador asignado, la jefa técnica o gerencia registra la compra') x;
  SELECT * INTO s FROM public.tecnica_solicitudes WHERE id = p_id AND account_id = a FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido no encontrado' USING ERRCODE = 'P0002'; END IF;
  IF s.estado NOT IN ('asignada', 'comprada') THEN
    RAISE EXCEPTION 'Solo se registra la compra de un pedido asignado (este está %)', s.estado USING ERRCODE = '22023';
  END IF;
  IF v_rol NOT IN ('jefe', 'gerencia') AND s.comprador_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Solo el comprador asignado, la jefa técnica o gerencia registra la compra' USING ERRCODE = '42501';
  END IF;
  IF p_monto IS NULL OR p_monto < 0 THEN
    RAISE EXCEPTION 'El monto de la compra debe ser cero o más' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_vuelto, 0) < 0 THEN
    RAISE EXCEPTION 'El vuelto no puede ser negativo' USING ERRCODE = '22023';
  END IF;
  IF p_comprobante_tipo IS NULL OR p_comprobante_tipo NOT IN ('boleta', 'factura', 'ticket', 'sin_comprobante') THEN
    RAISE EXCEPTION 'El comprobante debe ser boleta, factura, ticket o sin_comprobante' USING ERRCODE = '22023';
  END IF;
  v_prov := public.tecnica_texto(p_proveedor, 'El proveedor', 0, 120);
  v_num := public.tecnica_texto(p_comprobante_numero, 'El número de comprobante', 0, 60);
  v_nota := public.tecnica_texto(p_nota, 'La nota', 0, 500);
  IF v_path IS NOT NULL AND left(v_path, length(a::text || '/compras/' || p_id::text || '/')) <> a::text || '/compras/' || p_id::text || '/' THEN
    RAISE EXCEPTION 'El archivo del comprobante debe estar en la carpeta de este pedido (cuenta/compras/pedido/archivo)' USING ERRCODE = '22023';
  END IF;

  v_nueva := NOT EXISTS (SELECT 1 FROM public.tecnica_compras c WHERE c.solicitud_id = p_id);
  INSERT INTO public.tecnica_compras
    (solicitud_id, comprador_id, monto, proveedor, comprobante_tipo, comprobante_numero, comprobante_path, vuelto, nota, registrada_por)
  VALUES (p_id, s.comprador_id, p_monto, v_prov, p_comprobante_tipo, v_num, v_path, COALESCE(p_vuelto, 0), v_nota, auth.uid())
  ON CONFLICT (solicitud_id) DO UPDATE
    SET monto = EXCLUDED.monto, proveedor = EXCLUDED.proveedor, comprobante_tipo = EXCLUDED.comprobante_tipo,
        comprobante_numero = EXCLUDED.comprobante_numero,
        comprobante_path = COALESCE(EXCLUDED.comprobante_path, public.tecnica_compras.comprobante_path),
        vuelto = EXCLUDED.vuelto, nota = EXCLUDED.nota, actualizada_por = auth.uid(), actualizada_at = now();
  UPDATE public.tecnica_solicitudes SET estado = 'comprada', updated_at = now() WHERE id = p_id;
  PERFORM public.tecnica_audit('edito', 'tecnica_pedido', p_id::text,
    jsonb_build_object('numero', s.numero, 'paso', CASE WHEN v_nueva THEN 'compra_registrada' ELSE 'compra_corregida' END,
      'monto', p_monto, 'comprobante_tipo', p_comprobante_tipo, 'comprador_id', s.comprador_id));
END;
$$;

-- La jefa o gerencia cierra: comprada -> cerrada. Con pérdida > 0 el motivo es obligatorio y el
-- responsable por defecto es el comprador.
CREATE OR REPLACE FUNCTION public.tecnica_pedido_cerrar(
  p_id uuid, p_perdida numeric DEFAULT 0, p_perdida_motivo text DEFAULT NULL, p_perdida_responsable uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  s public.tecnica_solicitudes;
  v_perdida numeric := COALESCE(p_perdida, 0);
  v_motivo text;
  v_resp uuid;
BEGIN
  SELECT x.cuenta INTO a FROM public.tecnica_exigir(ARRAY['jefe', 'gerencia'], 'Solo la jefa técnica o gerencia cierra pedidos') x;
  SELECT * INTO s FROM public.tecnica_solicitudes WHERE id = p_id AND account_id = a FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido no encontrado' USING ERRCODE = 'P0002'; END IF;
  IF s.estado <> 'comprada' THEN
    RAISE EXCEPTION 'Solo se cierra un pedido ya comprado (este está %)', s.estado USING ERRCODE = '22023';
  END IF;
  IF v_perdida < 0 THEN
    RAISE EXCEPTION 'La pérdida no puede ser negativa' USING ERRCODE = '22023';
  END IF;
  IF v_perdida > 0 THEN
    v_motivo := public.tecnica_texto(p_perdida_motivo, 'El motivo de la pérdida', 1, 500);
    v_resp := COALESCE(p_perdida_responsable, s.comprador_id);
    IF v_resp IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = v_resp AND p.account_id = a) THEN
      RAISE EXCEPTION 'El responsable de la pérdida debe ser alguien de la cuenta' USING ERRCODE = '22023';
    END IF;
  END IF;
  UPDATE public.tecnica_compras
     SET perdida = v_perdida, perdida_motivo = v_motivo, perdida_responsable = v_resp
   WHERE solicitud_id = p_id;
  UPDATE public.tecnica_solicitudes
     SET estado = 'cerrada', cerrado_por = auth.uid(), cerrado_at = now(), updated_at = now()
   WHERE id = p_id;
  PERFORM public.tecnica_audit('edito', 'tecnica_pedido', p_id::text,
    jsonb_build_object('numero', s.numero, 'paso', 'cerrado', 'perdida', v_perdida, 'motivo', v_motivo,
                       'responsable_id', v_resp));
END;
$$;

-- Arma el jsonb de una lista de pedidos (interna). p_cola = true ordena para aprobar (urgentes y más antiguos primero).
CREATE OR REPLACE FUNCTION public.tecnica_pedidos_armar(
  p_account uuid, p_estado text, p_desde date, p_hasta date, p_cola boolean)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH f AS (
    SELECT s.* FROM public.tecnica_solicitudes s
     WHERE s.account_id = p_account
       AND (p_estado IS NULL OR s.estado = p_estado)
       AND (p_desde IS NULL OR (s.created_at AT TIME ZONE 'America/Lima')::date >= p_desde)
       AND (p_hasta IS NULL OR (s.created_at AT TIME ZONE 'America/Lima')::date <= p_hasta)
  ),
  pg AS (
    SELECT f.*, row_number() OVER (
             ORDER BY (p_cola AND f.urgente) DESC,
                      CASE WHEN p_cola THEN f.created_at END ASC,
                      CASE WHEN NOT p_cola THEN f.created_at END DESC,
                      f.numero DESC) AS rn
      FROM f ORDER BY rn LIMIT 300
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM f),
    'pedidos', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', s.id, 'numero', s.numero, 'obra', s.obra, 'project_id', s.project_id,
        'project_nombre', (SELECT r.name FROM public.real_estate_projects r WHERE r.id = s.project_id),
        'titulo', s.titulo, 'nota', s.nota, 'urgente', s.urgente, 'necesita_para', s.necesita_para,
        'monto_estimado', s.monto_estimado, 'estado', s.estado,
        'solicitado_por', s.solicitado_por, 'solicitante', public.tecnica_nombre(s.solicitado_por),
        'revisado_por', s.revisado_por, 'revisor', public.tecnica_nombre(s.revisado_por), 'revisado_at', s.revisado_at,
        'aprobado_por', s.aprobado_por, 'aprobador', public.tecnica_nombre(s.aprobado_por), 'aprobado_at', s.aprobado_at,
        'rechazado_por', s.rechazado_por, 'rechazador', public.tecnica_nombre(s.rechazado_por),
        'rechazado_at', s.rechazado_at, 'motivo_rechazo', s.motivo_rechazo,
        'comprador_id', s.comprador_id, 'comprador', public.tecnica_nombre(s.comprador_id),
        'asignado_por', s.asignado_por, 'asignado_at', s.asignado_at,
        'cerrado_por', s.cerrado_por, 'cerrador', public.tecnica_nombre(s.cerrado_por), 'cerrado_at', s.cerrado_at,
        'created_at', s.created_at, 'updated_at', s.updated_at,
        'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', i.id, 'orden', i.orden, 'descripcion', i.descripcion,
                    'cantidad', i.cantidad, 'unidad', i.unidad, 'precio_estimado', i.precio_estimado) ORDER BY i.orden)
                  FROM public.tecnica_solicitud_items i WHERE i.solicitud_id = s.id), '[]'::jsonb),
        'compra', (SELECT jsonb_build_object('monto', c.monto, 'proveedor', c.proveedor,
                    'comprobante_tipo', c.comprobante_tipo, 'comprobante_numero', c.comprobante_numero,
                    'comprobante_path', c.comprobante_path, 'vuelto', c.vuelto, 'nota', c.nota,
                    'comprador_id', c.comprador_id, 'comprador', public.tecnica_nombre(c.comprador_id),
                    'registrada_por', c.registrada_por, 'registrada_at', c.registrada_at,
                    'perdida', c.perdida, 'perdida_motivo', c.perdida_motivo,
                    'perdida_responsable', c.perdida_responsable,
                    'perdida_responsable_nombre', public.tecnica_nombre(c.perdida_responsable))
                  FROM public.tecnica_compras c WHERE c.solicitud_id = s.id)
      ) ORDER BY s.rn) FROM pg s), '[]'::jsonb));
$$;

-- Lista de pedidos de la cuenta (todos los roles con acceso; el equipo es chico y ve todo). Máximo 300.
-- Devuelve {total, pedidos:[...]}. p_hasta es inclusive. Fechas por la fecha en que se pidió (Lima).
CREATE OR REPLACE FUNCTION public.tecnica_pedidos_lista(
  p_estado text DEFAULT NULL, p_desde date DEFAULT NULL, p_hasta date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
BEGIN
  SELECT x.cuenta INTO a FROM public.tecnica_exigir(ARRAY['gerencia', 'jefe', 'equipo', 'lectura'], 'Sin permiso para ver los pedidos') x;
  IF p_estado IS NOT NULL AND p_estado NOT IN ('pedida', 'por_aprobar', 'aprobada', 'asignada', 'comprada', 'cerrada', 'rechazada', 'anulada') THEN
    RAISE EXCEPTION 'Estado no válido' USING ERRCODE = '22023';
  END IF;
  RETURN public.tecnica_pedidos_armar(a, p_estado, p_desde, p_hasta, false);
END;
$$;

-- Solo gerencia (la usa la app Gerencia en Aprobar). Devuelve {total, pedidos:[...]}, urgentes y más antiguos primero.
CREATE OR REPLACE FUNCTION public.tecnica_por_aprobar()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
BEGIN
  SELECT x.cuenta INTO a FROM public.tecnica_exigir(ARRAY['gerencia'], 'Solo gerencia ve los pedidos por aprobar') x;
  RETURN public.tecnica_pedidos_armar(a, 'por_aprobar', NULL, NULL, true);
END;
$$;

-- Resumen del mes (hora de Lima). Año y mes vacíos = el mes de hoy.
CREATE OR REPLACE FUNCTION public.tecnica_resumen(p_anio integer DEFAULT NULL, p_mes integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_hoy date := public.tecnica_hoy();
  v_anio integer := COALESCE(p_anio, EXTRACT(year FROM public.tecnica_hoy())::integer);
  v_mes integer := COALESCE(p_mes, EXTRACT(month FROM public.tecnica_hoy())::integer);
  v_desde date;
  v_hasta date;
  v_conteo jsonb;
  v_pedidos_mes integer;
  v_gasto numeric;
  v_gasto_obra jsonb;
  v_gasto_comprador jsonb;
  v_perdida numeric;
  v_perdida_resp jsonb;
  v_prestamos jsonb;
BEGIN
  SELECT x.cuenta INTO a FROM public.tecnica_exigir(ARRAY['gerencia', 'jefe', 'equipo', 'lectura'], 'Sin permiso para ver el resumen') x;
  IF v_anio < 2000 OR v_anio > 2100 THEN RAISE EXCEPTION 'Año no válido' USING ERRCODE = '22023'; END IF;
  IF v_mes < 1 OR v_mes > 12 THEN RAISE EXCEPTION 'Mes no válido' USING ERRCODE = '22023'; END IF;
  v_desde := make_date(v_anio, v_mes, 1);
  v_hasta := (v_desde + interval '1 month')::date;

  SELECT jsonb_object_agg(e.estado, COALESCE(c.n, 0)) INTO v_conteo
    FROM unnest(ARRAY['pedida', 'por_aprobar', 'aprobada', 'asignada', 'comprada', 'cerrada', 'rechazada', 'anulada']) AS e(estado)
    LEFT JOIN (SELECT s.estado, count(*) AS n FROM public.tecnica_solicitudes s WHERE s.account_id = a GROUP BY s.estado) c
           ON c.estado = e.estado;

  SELECT count(*) INTO v_pedidos_mes FROM public.tecnica_solicitudes s
   WHERE s.account_id = a AND (s.created_at AT TIME ZONE 'America/Lima')::date >= v_desde
     AND (s.created_at AT TIME ZONE 'America/Lima')::date < v_hasta;

  SELECT COALESCE(sum(c.monto), 0) INTO v_gasto
    FROM public.tecnica_compras c JOIN public.tecnica_solicitudes s ON s.id = c.solicitud_id
   WHERE s.account_id = a AND (c.registrada_at AT TIME ZONE 'America/Lima')::date >= v_desde
     AND (c.registrada_at AT TIME ZONE 'America/Lima')::date < v_hasta;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('obra', t.obra, 'monto', t.monto, 'compras', t.n) ORDER BY t.monto DESC, t.obra), '[]'::jsonb)
    INTO v_gasto_obra
    FROM (SELECT min(s.obra) AS obra, sum(c.monto) AS monto, count(*) AS n
            FROM public.tecnica_compras c JOIN public.tecnica_solicitudes s ON s.id = c.solicitud_id
           WHERE s.account_id = a AND (c.registrada_at AT TIME ZONE 'America/Lima')::date >= v_desde
             AND (c.registrada_at AT TIME ZONE 'America/Lima')::date < v_hasta
           GROUP BY lower(btrim(s.obra))) t;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('comprador_id', t.comprador_id, 'nombre', public.tecnica_nombre(t.comprador_id),
                                               'monto', t.monto, 'compras', t.n) ORDER BY t.monto DESC, t.comprador_id), '[]'::jsonb)
    INTO v_gasto_comprador
    FROM (SELECT c.comprador_id, sum(c.monto) AS monto, count(*) AS n
            FROM public.tecnica_compras c JOIN public.tecnica_solicitudes s ON s.id = c.solicitud_id
           WHERE s.account_id = a AND (c.registrada_at AT TIME ZONE 'America/Lima')::date >= v_desde
             AND (c.registrada_at AT TIME ZONE 'America/Lima')::date < v_hasta
           GROUP BY c.comprador_id) t;

  SELECT COALESCE(sum(c.perdida), 0) INTO v_perdida
    FROM public.tecnica_compras c JOIN public.tecnica_solicitudes s ON s.id = c.solicitud_id
   WHERE s.account_id = a AND s.estado = 'cerrada' AND c.perdida > 0
     AND (s.cerrado_at AT TIME ZONE 'America/Lima')::date >= v_desde
     AND (s.cerrado_at AT TIME ZONE 'America/Lima')::date < v_hasta;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('responsable_id', t.resp, 'nombre', public.tecnica_nombre(t.resp),
                                               'monto', t.monto, 'casos', t.n) ORDER BY t.monto DESC, t.resp), '[]'::jsonb)
    INTO v_perdida_resp
    FROM (SELECT c.perdida_responsable AS resp, sum(c.perdida) AS monto, count(*) AS n
            FROM public.tecnica_compras c JOIN public.tecnica_solicitudes s ON s.id = c.solicitud_id
           WHERE s.account_id = a AND s.estado = 'cerrada' AND c.perdida > 0
             AND (s.cerrado_at AT TIME ZONE 'America/Lima')::date >= v_desde
             AND (s.cerrado_at AT TIME ZONE 'America/Lima')::date < v_hasta
           GROUP BY c.perdida_responsable) t;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', m.id, 'material', m.material, 'cantidad', m.cantidad, 'unidad', m.unidad,
        'obra', m.obra, 'responsable_id', m.responsable_id,
        'responsable_nombre', COALESCE(public.tecnica_nombre(m.responsable_id), m.responsable_nombre),
        'devolver_antes', m.devolver_antes, 'dias_vencido', v_hoy - m.devolver_antes) ORDER BY m.devolver_antes, m.created_at), '[]'::jsonb)
    INTO v_prestamos
    FROM public.tecnica_almacen_movimientos m
   WHERE m.account_id = a AND m.tipo = 'salida' AND m.es_prestamo AND m.devuelto_at IS NULL
     AND m.devolver_antes IS NOT NULL AND m.devolver_antes < v_hoy;

  RETURN jsonb_build_object(
    'anio', v_anio, 'mes', v_mes,
    'conteo_por_estado', v_conteo,
    'pedidos_del_mes', v_pedidos_mes,
    'gasto_mes', jsonb_build_object('total', v_gasto, 'por_obra', v_gasto_obra, 'por_comprador', v_gasto_comprador),
    'perdidas_mes', jsonb_build_object('total', v_perdida, 'por_responsable', v_perdida_resp),
    'prestamos_vencidos', v_prestamos);
END;
$$;

-- ============================================================
-- 7. Almacén
-- ============================================================
-- tipo: ingreso | salida | devolucion. es_prestamo solo en salidas (herramienta que vuelve).
CREATE OR REPLACE FUNCTION public.tecnica_almacen_registrar(
  p_tipo text, p_material text, p_cantidad numeric, p_unidad text DEFAULT NULL, p_obra text DEFAULT NULL,
  p_es_prestamo boolean DEFAULT false, p_responsable_id uuid DEFAULT NULL, p_responsable_nombre text DEFAULT NULL,
  p_devolver_antes date DEFAULT NULL, p_solicitud_id uuid DEFAULT NULL, p_nota text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_id uuid := gen_random_uuid();
  v_material text;
  v_unidad text;
  v_obra text;
  v_resp_nombre text;
  v_nota text;
  v_prestamo boolean := COALESCE(p_es_prestamo, false);
BEGIN
  SELECT x.cuenta INTO a FROM public.tecnica_exigir(ARRAY['jefe', 'equipo', 'gerencia'], 'Solo el área técnica o gerencia mueve el almacén') x;
  IF p_tipo IS NULL OR p_tipo NOT IN ('ingreso', 'salida', 'devolucion') THEN
    RAISE EXCEPTION 'El tipo debe ser ingreso, salida o devolucion' USING ERRCODE = '22023';
  END IF;
  v_material := public.tecnica_texto(p_material, 'El material', 1, 160);
  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RAISE EXCEPTION 'La cantidad debe ser mayor que cero' USING ERRCODE = '22023';
  END IF;
  v_unidad := lower(COALESCE(public.tecnica_texto(p_unidad, 'La unidad', 0, 30), 'unidad'));
  v_obra := public.tecnica_texto(p_obra, 'La obra', 0, 120);
  v_resp_nombre := public.tecnica_texto(p_responsable_nombre, 'El nombre del responsable', 0, 120);
  v_nota := public.tecnica_texto(p_nota, 'La nota', 0, 500);
  IF v_prestamo AND p_tipo <> 'salida' THEN
    RAISE EXCEPTION 'Solo una salida puede ser préstamo' USING ERRCODE = '22023';
  END IF;
  IF v_prestamo AND p_responsable_id IS NULL AND v_resp_nombre IS NULL THEN
    RAISE EXCEPTION 'Un préstamo necesita responsable (alguien del equipo o un nombre externo)' USING ERRCODE = '22023';
  END IF;
  IF p_devolver_antes IS NOT NULL AND NOT v_prestamo THEN
    RAISE EXCEPTION 'Solo un préstamo lleva fecha para devolver' USING ERRCODE = '22023';
  END IF;
  IF p_responsable_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.profiles p WHERE p.user_id = p_responsable_id AND p.account_id = a) THEN
    RAISE EXCEPTION 'El responsable debe ser alguien de la cuenta' USING ERRCODE = '22023';
  END IF;
  IF p_solicitud_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.tecnica_solicitudes s WHERE s.id = p_solicitud_id AND s.account_id = a) THEN
    RAISE EXCEPTION 'Pedido no encontrado' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.tecnica_almacen_movimientos
    (id, account_id, tipo, material, cantidad, unidad, obra, es_prestamo, responsable_id, responsable_nombre,
     devolver_antes, solicitud_id, nota, registrado_por)
  VALUES (v_id, a, p_tipo, v_material, p_cantidad, v_unidad, v_obra, v_prestamo, p_responsable_id, v_resp_nombre,
          p_devolver_antes, p_solicitud_id, v_nota, auth.uid());
  PERFORM public.tecnica_audit('creo', 'tecnica_almacen', v_id::text,
    jsonb_build_object('tipo', p_tipo, 'material', v_material, 'cantidad', p_cantidad, 'unidad', v_unidad,
                       'es_prestamo', v_prestamo, 'obra', v_obra));
  RETURN v_id;
END;
$$;

-- Devuelve (en todo o en parte) una salida en préstamo. Crea la devolución con movimiento_origen y,
-- cuando ya volvió todo, marca devuelto_at en la salida. p_cantidad vacío = todo lo que falta. Devuelve el id de la devolución.
CREATE OR REPLACE FUNCTION public.tecnica_almacen_devolver(p_salida_id uuid, p_cantidad numeric DEFAULT NULL, p_nota text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  s public.tecnica_almacen_movimientos;
  v_id uuid := gen_random_uuid();
  v_devuelto numeric;
  v_falta numeric;
  v_cant numeric;
  v_nota text;
BEGIN
  SELECT x.cuenta INTO a FROM public.tecnica_exigir(ARRAY['jefe', 'equipo', 'gerencia'], 'Solo el área técnica o gerencia mueve el almacén') x;
  SELECT * INTO s FROM public.tecnica_almacen_movimientos WHERE id = p_salida_id AND account_id = a FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Movimiento no encontrado' USING ERRCODE = 'P0002'; END IF;
  IF s.tipo <> 'salida' OR NOT s.es_prestamo THEN
    RAISE EXCEPTION 'Solo se devuelve una salida en préstamo' USING ERRCODE = '22023';
  END IF;
  IF s.devuelto_at IS NOT NULL THEN
    RAISE EXCEPTION 'Este préstamo ya fue devuelto' USING ERRCODE = '22023';
  END IF;
  v_nota := public.tecnica_texto(p_nota, 'La nota', 0, 500);
  SELECT COALESCE(sum(d.cantidad), 0) INTO v_devuelto FROM public.tecnica_almacen_movimientos d
   WHERE d.movimiento_origen = s.id AND d.tipo = 'devolucion';
  v_falta := s.cantidad - v_devuelto;
  v_cant := COALESCE(p_cantidad, v_falta);
  IF v_cant <= 0 OR v_cant > v_falta THEN
    RAISE EXCEPTION 'La cantidad a devolver debe ser mayor que cero y no pasar de lo que falta (%)', v_falta USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.tecnica_almacen_movimientos
    (id, account_id, tipo, material, cantidad, unidad, obra, es_prestamo, responsable_id, responsable_nombre,
     movimiento_origen, solicitud_id, nota, registrado_por)
  VALUES (v_id, a, 'devolucion', s.material, v_cant, s.unidad, s.obra, false, s.responsable_id, s.responsable_nombre,
          s.id, s.solicitud_id, v_nota, auth.uid());
  IF v_cant >= v_falta THEN
    UPDATE public.tecnica_almacen_movimientos SET devuelto_at = now() WHERE id = s.id;
  END IF;
  PERFORM public.tecnica_audit('creo', 'tecnica_almacen', v_id::text,
    jsonb_build_object('tipo', 'devolucion', 'salida', s.id, 'material', s.material, 'cantidad', v_cant,
                       'completa', v_cant >= v_falta));
  RETURN v_id;
END;
$$;

-- Movimientos del almacén. Devuelve {total, movimientos:[...]}, los más nuevos primero, máximo 500.
CREATE OR REPLACE FUNCTION public.tecnica_almacen_lista(p_desde date DEFAULT NULL, p_hasta date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
BEGIN
  SELECT x.cuenta INTO a FROM public.tecnica_exigir(ARRAY['gerencia', 'jefe', 'equipo', 'lectura'], 'Sin permiso para ver el almacén') x;
  RETURN (
    WITH f AS (
      SELECT m.* FROM public.tecnica_almacen_movimientos m
       WHERE m.account_id = a
         AND (p_desde IS NULL OR (m.created_at AT TIME ZONE 'America/Lima')::date >= p_desde)
         AND (p_hasta IS NULL OR (m.created_at AT TIME ZONE 'America/Lima')::date <= p_hasta)
    ), pg AS (SELECT * FROM f ORDER BY created_at DESC, id LIMIT 500)
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM f),
      'movimientos', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', m.id, 'tipo', m.tipo, 'material', m.material, 'cantidad', m.cantidad, 'unidad', m.unidad, 'obra', m.obra,
          'es_prestamo', m.es_prestamo, 'responsable_id', m.responsable_id,
          'responsable_nombre', COALESCE(public.tecnica_nombre(m.responsable_id), m.responsable_nombre),
          'devolver_antes', m.devolver_antes, 'devuelto_at', m.devuelto_at, 'movimiento_origen', m.movimiento_origen,
          'solicitud_id', m.solicitud_id, 'nota', m.nota, 'registrado_por', m.registrado_por,
          'registrado_por_nombre', public.tecnica_nombre(m.registrado_por), 'created_at', m.created_at)
          ORDER BY m.created_at DESC, m.id) FROM pg m), '[]'::jsonb)));
END;
$$;

-- Stock por material y unidad (ingresos − salidas + devoluciones) y préstamos abiertos aparte.
-- Devuelve {stock:[...], prestamos_abiertos:[...]}.
CREATE OR REPLACE FUNCTION public.tecnica_almacen_stock()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_hoy date := public.tecnica_hoy();
BEGIN
  SELECT x.cuenta INTO a FROM public.tecnica_exigir(ARRAY['gerencia', 'jefe', 'equipo', 'lectura'], 'Sin permiso para ver el almacén') x;
  RETURN jsonb_build_object(
    'stock', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('material', t.material, 'unidad', t.unidad,
               'ingresos', t.ingresos, 'salidas', t.salidas, 'devoluciones', t.devoluciones,
               'stock', t.ingresos - t.salidas + t.devoluciones) ORDER BY lower(t.material), t.unidad)
        FROM (SELECT min(m.material) AS material, lower(btrim(m.unidad)) AS unidad,
                     COALESCE(sum(m.cantidad) FILTER (WHERE m.tipo = 'ingreso'), 0) AS ingresos,
                     COALESCE(sum(m.cantidad) FILTER (WHERE m.tipo = 'salida'), 0) AS salidas,
                     COALESCE(sum(m.cantidad) FILTER (WHERE m.tipo = 'devolucion'), 0) AS devoluciones
                FROM public.tecnica_almacen_movimientos m WHERE m.account_id = a
               GROUP BY lower(btrim(m.material)), lower(btrim(m.unidad))) t), '[]'::jsonb),
    'prestamos_abiertos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', m.id, 'material', m.material, 'cantidad', m.cantidad,
               'devuelto', d.devuelto, 'pendiente', m.cantidad - d.devuelto, 'unidad', m.unidad, 'obra', m.obra,
               'responsable_id', m.responsable_id,
               'responsable_nombre', COALESCE(public.tecnica_nombre(m.responsable_id), m.responsable_nombre),
               'devolver_antes', m.devolver_antes,
               'vencido', m.devolver_antes IS NOT NULL AND m.devolver_antes < v_hoy,
               'dias_vencido', CASE WHEN m.devolver_antes IS NOT NULL AND m.devolver_antes < v_hoy THEN v_hoy - m.devolver_antes END,
               'created_at', m.created_at) ORDER BY m.devolver_antes NULLS LAST, m.created_at)
        FROM public.tecnica_almacen_movimientos m
        CROSS JOIN LATERAL (SELECT COALESCE(sum(x.cantidad), 0) AS devuelto FROM public.tecnica_almacen_movimientos x
                             WHERE x.movimiento_origen = m.id AND x.tipo = 'devolucion') d
       WHERE m.account_id = a AND m.tipo = 'salida' AND m.es_prestamo AND m.devuelto_at IS NULL), '[]'::jsonb));
END;
$$;

-- ============================================================
-- 8. Fichas técnicas y planos
-- ============================================================
-- p_archivo_path debe ser {cuenta}/fichas/{uuid}/archivo en el bucket 'tecnica'. Devuelve el id.
CREATE OR REPLACE FUNCTION public.tecnica_ficha_crear(
  p_tipo text, p_titulo text, p_project_id uuid DEFAULT NULL, p_ubicacion text DEFAULT NULL,
  p_cliente_nombre text DEFAULT NULL, p_contrato_solicitud_id uuid DEFAULT NULL, p_archivo_path text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_id uuid := gen_random_uuid();
  v_titulo text;
  v_ubicacion text;
  v_cliente text;
  v_path text := NULLIF(btrim(COALESCE(p_archivo_path, '')), '');
  v_ok boolean;
BEGIN
  SELECT x.cuenta INTO a FROM public.tecnica_exigir(ARRAY['jefe', 'equipo', 'gerencia'], 'Solo el área técnica o gerencia sube fichas') x;
  IF p_tipo IS NULL OR p_tipo NOT IN ('ficha_tecnica', 'plano', 'plano_ubicacion', 'otro') THEN
    RAISE EXCEPTION 'El tipo debe ser ficha_tecnica, plano, plano_ubicacion u otro' USING ERRCODE = '22023';
  END IF;
  v_titulo := public.tecnica_texto(p_titulo, 'El título', 1, 140);
  v_ubicacion := public.tecnica_texto(p_ubicacion, 'La ubicación', 0, 120);
  v_cliente := public.tecnica_texto(p_cliente_nombre, 'El nombre del cliente', 0, 120);
  IF v_path IS NULL THEN
    RAISE EXCEPTION 'Falta el archivo de la ficha' USING ERRCODE = '22023';
  END IF;
  IF left(v_path, length(a::text || '/fichas/')) <> a::text || '/fichas/' THEN
    RAISE EXCEPTION 'El archivo debe estar en la carpeta de fichas de la cuenta (cuenta/fichas/id/archivo)' USING ERRCODE = '22023';
  END IF;
  IF p_project_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.real_estate_projects r WHERE r.id = p_project_id AND r.account_id = a) THEN
    RAISE EXCEPTION 'Proyecto no válido' USING ERRCODE = '22023';
  END IF;
  IF p_contrato_solicitud_id IS NOT NULL AND to_regclass('public.gh_lotes_solicitudes') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.gh_lotes_solicitudes s WHERE s.id = $1)' INTO v_ok USING p_contrato_solicitud_id;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'La separación del contrato no existe' USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.tecnica_fichas
    (id, account_id, tipo, titulo, project_id, ubicacion, cliente_nombre, contrato_solicitud_id, archivo_path, subida_por)
  VALUES (v_id, a, p_tipo, v_titulo, p_project_id, v_ubicacion, v_cliente, p_contrato_solicitud_id, v_path, auth.uid());
  PERFORM public.tecnica_audit('creo', 'tecnica_ficha', v_id::text,
    jsonb_build_object('tipo', p_tipo, 'titulo', v_titulo, 'ubicacion', v_ubicacion, 'contrato_solicitud_id', p_contrato_solicitud_id));
  RETURN v_id;
END;
$$;

-- Solo la jefa (gerencia como respaldo): borrador -> firmada.
CREATE OR REPLACE FUNCTION public.tecnica_ficha_firmar(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  f public.tecnica_fichas;
BEGIN
  SELECT x.cuenta INTO a FROM public.tecnica_exigir(ARRAY['jefe', 'gerencia'], 'Solo la jefa técnica firma las fichas') x;
  SELECT * INTO f FROM public.tecnica_fichas WHERE id = p_id AND account_id = a FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha no encontrada' USING ERRCODE = 'P0002'; END IF;
  IF f.estado <> 'borrador' THEN
    RAISE EXCEPTION 'Esta ficha ya está firmada' USING ERRCODE = '22023';
  END IF;
  UPDATE public.tecnica_fichas SET estado = 'firmada', firmada_por = auth.uid(), firmada_at = now() WHERE id = p_id;
  PERFORM public.tecnica_audit('aprobo', 'tecnica_ficha', p_id::text,
    jsonb_build_object('tipo', f.tipo, 'titulo', f.titulo, 'paso', 'firmada'));
END;
$$;

-- Lista de fichas (también la pueden llamar administración y legal para la lista de verificación del
-- contrato). p_q busca en título, ubicación, cliente y tipo. Devuelve {total, fichas:[...]}, máximo 300.
CREATE OR REPLACE FUNCTION public.tecnica_fichas_lista(p_q text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid := public.tecnica_ficha_lector();
  v_q text := NULLIF(btrim(COALESCE(p_q, '')), '');
BEGIN
  RETURN (
    WITH f AS (
      SELECT x.* FROM public.tecnica_fichas x
       WHERE x.account_id = a
         AND (v_q IS NULL OR x.titulo ILIKE '%' || v_q || '%' OR x.ubicacion ILIKE '%' || v_q || '%'
              OR x.cliente_nombre ILIKE '%' || v_q || '%' OR x.tipo ILIKE '%' || v_q || '%')
    ), pg AS (SELECT * FROM f ORDER BY created_at DESC, id LIMIT 300)
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM f),
      'fichas', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', x.id, 'tipo', x.tipo, 'titulo', x.titulo, 'project_id', x.project_id,
          'project_nombre', (SELECT r.name FROM public.real_estate_projects r WHERE r.id = x.project_id),
          'ubicacion', x.ubicacion, 'cliente_nombre', x.cliente_nombre,
          'contrato_solicitud_id', x.contrato_solicitud_id, 'archivo_path', x.archivo_path, 'estado', x.estado,
          'firmada_por', x.firmada_por, 'firmada_por_nombre', public.tecnica_nombre(x.firmada_por), 'firmada_at', x.firmada_at,
          'subida_por', x.subida_por, 'subida_por_nombre', public.tecnica_nombre(x.subida_por), 'created_at', x.created_at)
          ORDER BY x.created_at DESC, x.id) FROM pg x), '[]'::jsonb)));
END;
$$;

-- ============================================================
-- 9. Storage: bucket privado 'tecnica'
-- ============================================================
-- Rutas: {account_id}/compras/{solicitud_id}/archivo y {account_id}/fichas/{uuid}/archivo.
-- Límite 15 MB. PDF, imágenes y DWG (se guarda como application/octet-stream).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('tecnica', 'tecnica', false, 15728640, ARRAY['application/pdf', 'image/*', 'application/octet-stream'])
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit,
                               allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ¿Puede quien llama subir (o, con p_borrar, borrar) este archivo? Subir: jefe, equipo o gerencia de esa
-- cuenta; en compras el pedido tiene que existir en la cuenta. Borrar: solo jefe o gerencia (el comprobante
-- es evidencia y el equipo no lo quita).
CREATE OR REPLACE FUNCTION public.tecnica_storage_can_write(p_name text, p_borrar boolean DEFAULT false)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_parts text[] := string_to_array(p_name, '/');
  v_acc uuid;
  v_rol text;
  v_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF array_length(v_parts, 1) <> 4 OR v_parts[1] !~* v_re OR v_parts[3] !~* v_re
     OR v_parts[2] NOT IN ('compras', 'fichas') OR v_parts[4] = '' THEN
    RETURN false;
  END IF;
  v_acc := v_parts[1]::uuid;
  v_rol := public.tecnica_role(v_acc);
  IF v_rol IS NULL OR v_rol NOT IN ('jefe', 'equipo', 'gerencia') THEN RETURN false; END IF;
  IF COALESCE(p_borrar, false) AND v_rol NOT IN ('jefe', 'gerencia') THEN RETURN false; END IF;
  IF v_parts[2] = 'compras' THEN
    RETURN EXISTS (SELECT 1 FROM public.tecnica_solicitudes s WHERE s.id = v_parts[3]::uuid AND s.account_id = v_acc);
  END IF;
  RETURN true;
END;
$$;

-- ¿Puede quien llama leer este archivo? Cualquier rol (incluida lectura) de esa cuenta; legal solo las fichas.
CREATE OR REPLACE FUNCTION public.tecnica_storage_can_read(p_name text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_parts text[] := string_to_array(p_name, '/');
  v_acc uuid;
  v_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF array_length(v_parts, 1) < 2 OR v_parts[1] !~* v_re THEN RETURN false; END IF;
  v_acc := v_parts[1]::uuid;
  IF public.tecnica_role(v_acc) IS NOT NULL THEN RETURN true; END IF;
  RETURN v_parts[2] = 'fichas' AND auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p JOIN public.accounts ac ON ac.id = p.account_id
     WHERE p.user_id = auth.uid() AND p.account_id = v_acc AND ac.status = 'active'
       AND p.account_role <> 'viewer' AND p.area = 'legal');
END;
$$;

DROP POLICY IF EXISTS tecnica_storage_select ON storage.objects;
CREATE POLICY tecnica_storage_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'tecnica' AND public.tecnica_storage_can_read(name));
DROP POLICY IF EXISTS tecnica_storage_insert ON storage.objects;
CREATE POLICY tecnica_storage_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'tecnica' AND public.tecnica_storage_can_write(name, false));
DROP POLICY IF EXISTS tecnica_storage_delete ON storage.objects;
CREATE POLICY tecnica_storage_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'tecnica' AND public.tecnica_storage_can_write(name, true));

-- ============================================================
-- 10. Permisos de las funciones
-- ============================================================
DO $$
DECLARE
  f text;
BEGIN
  -- Internas: sin ningún GRANT.
  FOREACH f IN ARRAY ARRAY[
    'public.tecnica_rol_operativo_of(uuid,uuid)', 'public.tecnica_role_of(uuid,uuid)',
    'public.tecnica_cuenta()', 'public.tecnica_nombre(uuid)', 'public.tecnica_exigir(text[],text)',
    'public.tecnica_texto(text,text,integer,integer)', 'public.tecnica_unidad_item(text)',
    'public.tecnica_audit(text,text,text,jsonb)', 'public.tecnica_hoy()', 'public.tecnica_ficha_lector()',
    'public.tecnica_pedidos_armar(uuid,text,date,date,boolean)']
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  -- Publicadas: solo authenticated.
  FOREACH f IN ARRAY ARRAY[
    'public.tecnica_role(uuid)', 'public.tecnica_my_access()', 'public.tecnica_equipo(uuid)',
    'public.tecnica_pedido_crear(text,text,jsonb,boolean,date,uuid,text)',
    'public.tecnica_pedido_enviar(uuid)', 'public.tecnica_pedido_aprobar(uuid)',
    'public.tecnica_pedido_rechazar(uuid,text)', 'public.tecnica_pedido_anular(uuid)',
    'public.tecnica_pedido_asignar(uuid,uuid)',
    'public.tecnica_compra_registrar(uuid,numeric,text,text,text,text,numeric,text)',
    'public.tecnica_pedido_cerrar(uuid,numeric,text,uuid)',
    'public.tecnica_pedidos_lista(text,date,date)', 'public.tecnica_por_aprobar()',
    'public.tecnica_resumen(integer,integer)',
    'public.tecnica_almacen_registrar(text,text,numeric,text,text,boolean,uuid,text,date,uuid,text)',
    'public.tecnica_almacen_devolver(uuid,numeric,text)', 'public.tecnica_almacen_lista(date,date)',
    'public.tecnica_almacen_stock()',
    'public.tecnica_ficha_crear(text,text,uuid,text,text,uuid,text)', 'public.tecnica_ficha_firmar(uuid)',
    'public.tecnica_fichas_lista(text)',
    'public.tecnica_storage_can_write(text,boolean)', 'public.tecnica_storage_can_read(text)']
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END
$$;

COMMIT;

-- PostgREST lee el esquema nuevo sin reiniciar.
NOTIFY pgrst, 'reload schema';
