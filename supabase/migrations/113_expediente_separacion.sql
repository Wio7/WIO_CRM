-- ============================================================
-- 113_expediente_separacion.sql — Expediente de la separación (asesor -> Legal)
-- WIO_CRM, por PR (main protegido). Correr en el SQL Editor de wioCRM (WioSuite).
--
-- Qué se busca: cuando una separación está aprobada, el asesor que la pidió abre su expediente
-- (ya viene lleno con los datos de la separación), completa lo que falta, sube DNI, recibo y
-- vouchers y lo envía a Legal. Al enviarlo se marca la etapa 'expediente_legal' (la misma que
-- hoy marca a mano un aprobador con gh_etapa_marcar). Legal puede observarlo (lo devuelve con
-- motivo) y el asesor corrige y lo reenvía.
-- Contrato: CRM WIO\CONTRATO-expediente-2026-11-24.md (secciones 1 y 1.5).
--
-- Qué cambia:
--   1. gh_lotes_solicitudes.asesor_uid (uuid, índice parcial). Las solicitudes nuevas con sesión
--      guardan quién las pidió; las viejas y las anónimas quedan en NULL (la columna se agrega
--      SIN valor por defecto y recién después se le pone default auth.uid(), para no rellenar
--      las filas viejas con el usuario que corre la migración).
--   2. REEMPLAZA gh_lotes_al_solicitar() (098): igual que antes + fuerza new.asesor_uid := auth.uid()
--      (nadie puede poner otro uid al insertar).
--   3. Tabla gh_expedientes (RLS activo, sin políticas, sin permisos: solo por funciones).
--   4. Funciones: gh_expediente_abrir / guardar / enviar / observar, gh_mis_separaciones,
--      gh_expediente_puede (la usan las políticas de archivos) y ayudantes internos sin permiso
--      (gh_expediente_ver, _sugeridos, _faltante, _num, _txt, _fecha_ok).
--   5. REEMPLAZA gh_separaciones_panel() (098): igual que antes + expediente_estado y
--      expediente_observacion en cada fila (y quita asesor_uid del resultado, para que el panel
--      devuelva lo mismo de antes más esas dos claves).
--   6. Carpeta privada 'expedientes' (6 MB; imágenes y PDF) y sus reglas: insert y select solo
--      para quien puede ver ese expediente. Sin update ni delete.
--
-- gh_lotes_historial.tipo ya admite 'etapa' (098) y su columna etapa no tiene restricción: no hace
-- falta ampliar nada para 'expediente_observado'.
--
-- Requiere 098 (y 108 para tipo_separacion, que es opcional). La migración se detiene con un mensaje
-- claro si falta algo o si una de las dos funciones que reemplaza no es la del repo.
--
-- ANTES de aplicar, comprobar a mano las funciones vivas (la migración lo comprueba sola). La
-- huella es el md5 del cuerpo SIN espacios ni saltos de línea (así no importa CRLF/LF):
--   SELECT p.proname, md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p
--    WHERE p.pronamespace = 'public'::regnamespace
--      AND p.proname IN ('gh_lotes_al_solicitar', 'gh_separaciones_panel');
--   Deben salir:
--     gh_lotes_al_solicitar   795493cc667a9aac61bee65ffbef95a0  (098)
--     gh_separaciones_panel   accba99e7ebcbf6c22a765eda67236cd  (098)
--   Si ya corrió la 113, el cuerpo lleva la marca '113_expediente_separacion' y también pasa.
--   Si no coinciden, NO aplicar: la base real se desvía del repo.
--
-- Casos: CRM WIO\traspaso-catalogo\probar-113.mjs (PGlite, con la 098 y la 108 reales).
-- Idempotente — se puede volver a correr.
-- ============================================================
BEGIN;

-- ============================================================
-- 0. Guardas
-- ============================================================
DO $$
DECLARE
  f record;
  v_src text;
  v_faltan text;
BEGIN
  SELECT string_agg(t, ', ') INTO v_faltan
    FROM unnest(ARRAY['gh_lotes_solicitudes', 'gh_lotes_estado', 'gh_separacion_etapas', 'gh_lotes_historial', 'gh_equipo']) AS t
   WHERE to_regclass('public.' || t) IS NULL;
  IF v_faltan IS NOT NULL THEN
    RAISE EXCEPTION 'FALTAN_TABLAS_PARA_LA_113: % (aplicar antes la 098)', v_faltan;
  END IF;

  SELECT string_agg(t, ', ') INTO v_faltan
    FROM unnest(ARRAY['gh_area()', 'gh_es(text[])', 'gh_puede_resolver()', 'gh_solicitud_vigente(uuid)',
                      'gh_lotes_al_solicitar()', 'gh_separaciones_panel()']) AS t
   WHERE to_regprocedure('public.' || t) IS NULL;
  IF v_faltan IS NOT NULL THEN
    RAISE EXCEPTION 'FALTAN_FUNCIONES_PARA_LA_113: % (aplicar antes la 098)', v_faltan;
  END IF;

  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'FALTA_STORAGE_PARA_LA_113: no existe el esquema storage';
  END IF;

  FOR f IN SELECT * FROM (VALUES
      ('gh_lotes_al_solicitar()', '795493cc667a9aac61bee65ffbef95a0'),
      ('gh_separaciones_panel()', 'accba99e7ebcbf6c22a765eda67236cd')
    ) AS v(firma, huella)
  LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || f.firma);
    IF position('113_expediente_separacion' IN v_src) = 0
       AND md5(regexp_replace(v_src, '\s', '', 'g')) <> f.huella THEN
      RAISE EXCEPTION 'HUELLA_DISTINTA: public.% no es la del repo (md5 vivo %, esperado %). La base real se desvía: NO aplicar la 113 hasta revisarla.',
        f.firma, md5(regexp_replace(v_src, '\s', '', 'g')), f.huella;
    END IF;
  END LOOP;
END
$$;

-- ============================================================
-- 1. Quién es el asesor (asesor_uid)
-- ============================================================
ALTER TABLE public.gh_lotes_solicitudes ADD COLUMN IF NOT EXISTS asesor_uid uuid;
-- El default va aparte: así las filas viejas quedan en NULL.
ALTER TABLE public.gh_lotes_solicitudes ALTER COLUMN asesor_uid SET DEFAULT auth.uid();
CREATE INDEX IF NOT EXISTS gh_lotes_solicitudes_asesor_uid
  ON public.gh_lotes_solicitudes (asesor_uid) WHERE asesor_uid IS NOT NULL;

-- Igual que la 098, más la línea marcada con 113: nadie puede poner otro uid al insertar.
CREATE OR REPLACE FUNCTION public.gh_lotes_al_solicitar()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  actual text;
  falta  text;
begin
  -- 113_expediente_separacion
  -- El mensaje va en el hint: la app lo muestra tal cual al asesor.
  falta := case
    when coalesce(btrim(new.jefe_ventas), '') = '' then 'Indica el jefe de ventas.'
    when new.fecha_pago is null then 'Indica la fecha del pago.'
    when new.fecha_pago > current_date + 1 then 'La fecha del pago no puede ser futura.'
    when new.fecha_pago < current_date - 30 then 'La fecha del pago tiene más de 30 días: consúltalo con el administrador.'
    when new.medio_pago is null then 'Elige el medio de pago.'
    when new.forma_pago is null then 'Indica si el lote se paga al contado o financiado.'
    when new.medio_pago <> 'efectivo' and coalesce(btrim(new.operacion), '') = '' then 'Escribe el número de operación del voucher.'
    when new.medio_pago <> 'efectivo' and new.voucher_path is null then 'Adjunta la foto del voucher.'
    else null
  end;

  -- El voucher tiene que ser de este lote y existir de verdad: la ruta la
  -- escribe el navegador y no se le puede creer a ciegas.
  if falta is null and new.voucher_path is not null then
    if new.voucher_path not like new.proyecto || '/' || new.lote || '/%'
       or not exists (
         select 1 from storage.objects
          where bucket_id = 'separaciones' and name = new.voucher_path
       ) then
      falta := 'El voucher no se subió bien. Vuelve a adjuntarlo.';
    end if;
  end if;

  if falta is not null then
    raise exception 'SEPARACION_INCOMPLETA' using hint = falta;
  end if;

  select estado into actual
    from gh_lotes_estado
   where proyecto = new.proyecto and lote = new.lote
   for update;

  if actual is null then
    raise exception 'LOTE_NO_ACTIVO'
      using hint = 'El administrador todavía no activó los lotes de este proyecto.';
  end if;

  if actual <> 'libre' then
    raise exception 'LOTE_NO_LIBRE'
      using hint = 'Ese lote ya no está libre.';
  end if;

  -- Lo que llega del asesor no decide el resultado de la solicitud.
  new.estado         := 'pendiente';
  new.motivo_rechazo := null;
  new.resuelta       := null;
  new.resuelta_por   := null;
  new.creada         := now();
  -- Quién la pide lo decide la sesión, no el navegador (sin sesión queda NULL).
  new.asesor_uid     := auth.uid();

  update gh_lotes_estado
     set estado = 'solicitado', actualizado = now(), actualizado_por = new.asesor
   where proyecto = new.proyecto and lote = new.lote;

  return new;
end;
$function$;

-- ============================================================
-- 2. Tabla gh_expedientes (sin acceso directo: solo por funciones)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.gh_expedientes (
  solicitud        uuid PRIMARY KEY REFERENCES public.gh_lotes_solicitudes(id) ON DELETE CASCADE,
  estado           text NOT NULL DEFAULT 'borrador',
  datos            jsonb NOT NULL DEFAULT '{}'::jsonb,
  adjuntos         jsonb NOT NULL DEFAULT '{}'::jsonb,
  observacion      text,
  observado_por    text,
  observado_en     timestamptz,
  enviado_por      text,
  enviado_en       timestamptz,
  actualizado_por  text,
  creado           timestamptz NOT NULL DEFAULT now(),
  actualizado      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gh_expedientes_estado_check CHECK (estado IN ('borrador', 'enviado', 'observado')),
  CONSTRAINT gh_expedientes_datos_check CHECK (jsonb_typeof(datos) = 'object' AND octet_length(datos::text) <= 32768),
  CONSTRAINT gh_expedientes_adjuntos_check CHECK (jsonb_typeof(adjuntos) = 'object' AND octet_length(adjuntos::text) <= 16384),
  CONSTRAINT gh_expedientes_observacion_check CHECK (observacion IS NULL OR char_length(observacion) BETWEEN 3 AND 500)
);
ALTER TABLE public.gh_expedientes ENABLE ROW LEVEL SECURITY;
-- Sin políticas y sin permisos: nadie la toca directo.
REVOKE ALL ON public.gh_expedientes FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 3. Ayudantes internos (sin ningún GRANT)
-- ============================================================
-- Número desde jsonb (número o texto numérico); NULL si no es un número.
CREATE OR REPLACE FUNCTION public.gh_expediente_num(p_j jsonb)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  -- 113_expediente_separacion
  IF p_j IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_j) = 'number' THEN RETURN (p_j #>> '{}')::numeric; END IF;
  IF jsonb_typeof(p_j) = 'string' AND (p_j #>> '{}') ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' THEN
    RETURN btrim(p_j #>> '{}')::numeric;
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

-- Texto (no vacío) en una ruta de un jsonb; NULL si falta o no es texto.
CREATE OR REPLACE FUNCTION public.gh_expediente_txt(p_j jsonb, p_ruta text[])
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  -- 113_expediente_separacion
  SELECT CASE WHEN jsonb_typeof(p_j #> p_ruta) = 'string' THEN nullif(btrim(p_j #>> p_ruta), '') END;
$$;

-- Fecha YYYY-MM-DD que existe de verdad.
CREATE OR REPLACE FUNCTION public.gh_expediente_fecha_ok(p_j jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  -- 113_expediente_separacion
  IF p_j IS NULL OR jsonb_typeof(p_j) <> 'string' OR (p_j #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN false;
  END IF;
  PERFORM (p_j #>> '{}')::date;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$$;

-- Datos que se sugieren desde la solicitud (siempre se arman de ahí).
CREATE OR REPLACE FUNCTION public.gh_expediente_sugeridos(p_solicitud uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s public.gh_lotes_solicitudes%ROWTYPE;
  v_js jsonb;
  v_meses text[] := ARRAY['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];
BEGIN
  -- 113_expediente_separacion
  SELECT * INTO s FROM public.gh_lotes_solicitudes WHERE id = p_solicitud;
  IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
  v_js := to_jsonb(s);  -- así tipo_separacion se lee solo si la columna existe (108)
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'titular', jsonb_build_object('nombre', s.cliente_nombre, 'documento', s.cliente_documento,
                                  'telefono', s.cliente_telefono, 'correo', s.cliente_correo),
    'lote', jsonb_build_object('proyecto', s.proyecto, 'lote', s.lote),
    'asesor', s.asesor,
    'jefe_ventas', s.jefe_ventas,
    'precio_venta', s.precio_lote,
    'mes_venta', v_meses[extract(month FROM (s.creada AT TIME ZONE 'America/Lima'))::int],
    'pagos_inicial', CASE WHEN s.fecha_pago IS NOT NULL THEN
        jsonb_build_array(jsonb_build_object('fecha', s.fecha_pago, 'operacion', s.operacion,
                                             'monto', s.monto, 'banco', s.banco))
      END,
    'observaciones', s.observaciones,
    'forma_pago', s.forma_pago,
    'tipo_separacion', v_js ->> 'tipo_separacion',
    'medio_pago', s.medio_pago
  ));
END;
$$;

-- Estado del expediente + sugeridos, en la forma que devuelven abrir y guardar.
CREATE OR REPLACE FUNCTION public.gh_expediente_ver(p_solicitud uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  x public.gh_expedientes%ROWTYPE;
  v_sug jsonb := public.gh_expediente_sugeridos(p_solicitud);
  v_legal boolean;
  v_listo boolean;
BEGIN
  -- 113_expediente_separacion
  SELECT * INTO x FROM public.gh_expedientes WHERE solicitud = p_solicitud;
  v_legal := EXISTS (SELECT 1 FROM public.gh_separacion_etapas t WHERE t.solicitud = p_solicitud AND t.etapa = 'expediente_legal');
  v_listo := EXISTS (SELECT 1 FROM public.gh_separacion_etapas t WHERE t.solicitud = p_solicitud AND t.etapa = 'contrato_listo');
  RETURN jsonb_build_object(
    'solicitud', p_solicitud,
    'estado', CASE WHEN x.solicitud IS NULL THEN 'nuevo' ELSE x.estado END,
    'datos', CASE WHEN x.solicitud IS NULL THEN v_sug ELSE x.datos END,
    'adjuntos', CASE WHEN x.solicitud IS NULL THEN '{}'::jsonb ELSE x.adjuntos END,
    'observacion', x.observacion,
    'observado_por', x.observado_por,
    'observado_en', x.observado_en,
    'enviado_en', x.enviado_en,
    'etapa_legal', v_legal,
    'contrato_listo', v_listo,
    'sugeridos', v_sug
  );
END;
$$;

-- Primer faltante para enviar (texto para la persona) o NULL si está completo.
-- Orden (contrato 1.3 + 1.5): titular, cotitular, dirección, lote, precio, descuento, inicial,
-- pagos, cuotas, DNI del titular, DNI del cotitular, recibo, voucher.
CREATE OR REPLACE FUNCTION public.gh_expediente_faltante(p_datos jsonb, p_adjuntos jsonb, p_forma_pago text)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d jsonb := coalesce(p_datos, '{}'::jsonb);
  a jsonb := coalesce(p_adjuntos, '{}'::jsonb);
  c jsonb;
  n numeric;
  v_lista numeric;
  v_venta numeric;
BEGIN
  -- 113_expediente_separacion
  IF public.gh_expediente_txt(d, '{titular,nombre}') IS NULL THEN RETURN 'Falta el nombre del titular.'; END IF;
  IF public.gh_expediente_txt(d, '{titular,documento}') IS NULL THEN RETURN 'Falta el documento del titular.'; END IF;
  IF public.gh_expediente_txt(d, '{titular,telefono}') IS NULL THEN RETURN 'Falta el teléfono del titular.'; END IF;

  IF jsonb_typeof(d -> 'cotitular') = 'object' THEN
    IF public.gh_expediente_txt(d, '{cotitular,nombre}') IS NULL THEN RETURN 'Falta el nombre del cotitular.'; END IF;
    IF public.gh_expediente_txt(d, '{cotitular,documento}') IS NULL THEN RETURN 'Falta el documento del cotitular.'; END IF;
  END IF;

  IF public.gh_expediente_txt(d, '{direccion,linea}') IS NULL THEN RETURN 'Falta la dirección del titular.'; END IF;
  IF public.gh_expediente_txt(d, '{direccion,distrito}') IS NULL THEN RETURN 'Falta el distrito del titular.'; END IF;
  IF public.gh_expediente_txt(d, '{lote,manzana}') IS NULL THEN RETURN 'Falta la manzana del lote.'; END IF;
  IF public.gh_expediente_txt(d, '{lote,lote}') IS NULL THEN RETURN 'Falta el número de lote.'; END IF;

  v_venta := public.gh_expediente_num(d -> 'precio_venta');
  IF coalesce(v_venta, 0) <= 0 THEN RETURN 'Falta el precio de venta.'; END IF;

  v_lista := public.gh_expediente_num(d -> 'precio_lista');
  IF v_lista IS NOT NULL AND v_lista > v_venta THEN
    IF public.gh_expediente_txt(d, '{descuento,motivo}') IS NULL
       OR public.gh_expediente_txt(d, '{descuento,autorizo}') IS NULL THEN
      RETURN 'Indica el motivo del descuento y quién lo autorizó.';
    END IF;
  END IF;

  IF coalesce(p_forma_pago, '') <> 'contado' AND coalesce(public.gh_expediente_num(d -> 'inicial_total'), 0) <= 0 THEN
    RETURN 'Falta el total de la inicial.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d -> 'pagos_inicial') = 'array' THEN d -> 'pagos_inicial' ELSE '[]'::jsonb END) p
     WHERE public.gh_expediente_fecha_ok(p -> 'fecha')
       AND public.gh_expediente_txt(p, '{operacion}') IS NOT NULL
       AND coalesce(public.gh_expediente_num(p -> 'monto'), 0) > 0
  ) THEN
    RETURN 'Agrega al menos un pago de la inicial con fecha, número de operación y monto.';
  END IF;

  c := d -> 'cuotas';
  IF c IS NOT NULL AND jsonb_typeof(c) <> 'null' THEN
    n := CASE WHEN jsonb_typeof(c) = 'object' THEN public.gh_expediente_num(c -> 'numero') END;
    IF n IS NULL OR n <> trunc(n) OR n < 1 OR n > 84 THEN RETURN 'Indica el número de cuotas (de 1 a 84).'; END IF;
    IF coalesce(public.gh_expediente_num(c -> 'monto'), 0) <= 0 THEN RETURN 'Indica el monto de la cuota.'; END IF;
    IF NOT public.gh_expediente_fecha_ok(c -> 'inicio') THEN RETURN 'Indica la fecha de inicio de las cuotas.'; END IF;
  END IF;

  IF public.gh_expediente_txt(a, '{dni_frente}') IS NULL THEN RETURN 'Falta la foto del DNI (frente).'; END IF;
  IF public.gh_expediente_txt(a, '{dni_reverso}') IS NULL THEN RETURN 'Falta la foto del DNI (reverso).'; END IF;
  IF jsonb_typeof(d -> 'cotitular') = 'object' THEN
    IF public.gh_expediente_txt(a, '{dni_cotitular_frente}') IS NULL THEN RETURN 'Falta la foto del DNI del cotitular (frente).'; END IF;
    IF public.gh_expediente_txt(a, '{dni_cotitular_reverso}') IS NULL THEN RETURN 'Falta la foto del DNI del cotitular (reverso).'; END IF;
  END IF;
  IF public.gh_expediente_txt(a, '{recibo}') IS NULL THEN RETURN 'Falta el recibo de servicio.'; END IF;
  IF NOT (CASE WHEN jsonb_typeof(a -> 'vouchers') = 'array' THEN jsonb_array_length(a -> 'vouchers') >= 1 ELSE false END) THEN
    RETURN 'Falta al menos un voucher.';
  END IF;
  RETURN NULL;
END;
$$;

-- ¿Puede esta persona ver/armar el expediente de esta solicitud? La usan las demás funciones y las
-- reglas de archivos. (Las reglas de storage corren con los permisos de quien llama: por eso este
-- ayudante, a diferencia de los demás, SÍ tiene GRANT para authenticated; solo responde sí/no.)
CREATE OR REPLACE FUNCTION public.gh_expediente_puede(p_solicitud uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  -- 113_expediente_separacion
  SELECT coalesce(
           EXISTS (SELECT 1 FROM public.gh_lotes_solicitudes s
                    WHERE s.id = p_solicitud AND auth.uid() IS NOT NULL AND s.asesor_uid = auth.uid())
           OR public.gh_puede_resolver()
           OR public.gh_es(ARRAY['dueno', 'legal']),
         false);
$$;

-- Lo mismo a partir de la ruta de un archivo (<solicitud>/<archivo>); false si la ruta no tiene esa forma.
CREATE OR REPLACE FUNCTION public.gh_expediente_puede_ruta(p_name text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_carpetas text[];
  v_id uuid;
BEGIN
  -- 113_expediente_separacion
  IF p_name IS NULL OR right(p_name, 1) = '/' THEN RETURN false; END IF;
  v_carpetas := storage.foldername(p_name);
  IF coalesce(array_length(v_carpetas, 1), 0) <> 1 THEN RETURN false; END IF;
  BEGIN
    v_id := v_carpetas[1]::uuid;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  RETURN public.gh_expediente_puede(v_id);
END;
$$;

-- ============================================================
-- 4. Funciones públicas (solo authenticated)
-- ============================================================
CREATE OR REPLACE FUNCTION public.gh_expediente_abrir(p_solicitud uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s public.gh_lotes_solicitudes%ROWTYPE;
BEGIN
  -- 113_expediente_separacion
  IF NOT public.gh_expediente_puede(p_solicitud) THEN
    RAISE EXCEPTION 'SIN_PERMISO' USING errcode = '42501', hint = 'Este expediente no es tuyo.';
  END IF;
  SELECT * INTO s FROM public.gh_lotes_solicitudes WHERE id = p_solicitud;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOLICITUD_NO_EXISTE' USING hint = 'Esa separación no existe.';
  END IF;
  IF s.estado <> 'aprobada' THEN
    RAISE EXCEPTION 'SOLICITUD_NO_APROBADA' USING hint = 'El expediente se arma cuando la separación está aprobada.';
  END IF;
  IF NOT public.gh_solicitud_vigente(p_solicitud) THEN
    RAISE EXCEPTION 'SEPARACION_NO_VIGENTE' USING hint = 'Esa separación ya no es la vigente del lote.';
  END IF;
  RETURN public.gh_expediente_ver(p_solicitud);
END;
$$;

CREATE OR REPLACE FUNCTION public.gh_expediente_guardar(p_solicitud uuid, p_datos jsonb, p_adjuntos jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s public.gh_lotes_solicitudes%ROWTYPE;
  x public.gh_expedientes%ROWTYPE;
  v_quien text := coalesce(nullif(lower(auth.jwt() ->> 'email'), ''), 'sin-correo');
  v_clave text;
  v_ruta jsonb;
  v_prefijo text := p_solicitud::text || '/';
BEGIN
  -- 113_expediente_separacion
  IF NOT public.gh_expediente_puede(p_solicitud) THEN
    RAISE EXCEPTION 'SIN_PERMISO' USING errcode = '42501', hint = 'Este expediente no es tuyo.';
  END IF;
  SELECT * INTO s FROM public.gh_lotes_solicitudes WHERE id = p_solicitud FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOLICITUD_NO_EXISTE' USING hint = 'Esa separación no existe.';
  END IF;
  IF s.estado <> 'aprobada' THEN
    RAISE EXCEPTION 'SOLICITUD_NO_APROBADA' USING hint = 'El expediente se arma cuando la separación está aprobada.';
  END IF;
  IF NOT public.gh_solicitud_vigente(p_solicitud) THEN
    RAISE EXCEPTION 'SEPARACION_NO_VIGENTE' USING hint = 'Esa separación ya no es la vigente del lote.';
  END IF;

  SELECT * INTO x FROM public.gh_expedientes WHERE solicitud = p_solicitud FOR UPDATE;
  IF FOUND AND x.estado = 'enviado' THEN
    RAISE EXCEPTION 'EXPEDIENTE_ENVIADO' USING hint = 'Ya está en Legal. Espera su respuesta.';
  END IF;

  -- Forma de lo que llega
  IF p_datos IS NULL OR jsonb_typeof(p_datos) <> 'object' THEN
    RAISE EXCEPTION 'DATOS_INVALIDOS' USING hint = 'Los datos del expediente no tienen el formato correcto.';
  END IF;
  IF octet_length(p_datos::text) > 32768 THEN
    RAISE EXCEPTION 'DATOS_INVALIDOS' USING hint = 'El expediente es demasiado largo. Acorta los textos.';
  END IF;
  IF jsonb_typeof(p_datos -> 'observaciones') = 'string' AND char_length(p_datos ->> 'observaciones') > 1000 THEN
    RAISE EXCEPTION 'DATOS_INVALIDOS' USING hint = 'Las observaciones pueden tener hasta 1000 letras.';
  END IF;
  IF (CASE WHEN jsonb_typeof(p_datos -> 'pagos_inicial') = 'array' THEN jsonb_array_length(p_datos -> 'pagos_inicial') > 20 ELSE false END) THEN
    RAISE EXCEPTION 'DATOS_INVALIDOS' USING hint = 'Puedes registrar hasta 20 pagos de la inicial.';
  END IF;

  IF p_adjuntos IS NULL OR jsonb_typeof(p_adjuntos) <> 'object' THEN
    RAISE EXCEPTION 'ADJUNTO_INVALIDO' USING hint = 'Los archivos del expediente no tienen el formato correcto.';
  END IF;
  FOR v_clave IN SELECT jsonb_object_keys(p_adjuntos) LOOP
    IF v_clave NOT IN ('dni_frente', 'dni_reverso', 'dni_cotitular_frente', 'dni_cotitular_reverso', 'recibo', 'vouchers') THEN
      RAISE EXCEPTION 'ADJUNTO_INVALIDO' USING hint = 'Hay un archivo que no corresponde al expediente. Vuelve a subirlo.';
    END IF;
    IF v_clave = 'vouchers' THEN
      IF NOT (CASE WHEN jsonb_typeof(p_adjuntos -> v_clave) = 'array' THEN jsonb_array_length(p_adjuntos -> v_clave) <= 10 ELSE false END) THEN
        RAISE EXCEPTION 'ADJUNTO_INVALIDO' USING hint = 'Puedes subir hasta 10 vouchers.';
      END IF;
      FOR v_ruta IN SELECT jsonb_array_elements(p_adjuntos -> v_clave) LOOP
        IF jsonb_typeof(v_ruta) <> 'string' OR left(v_ruta #>> '{}', length(v_prefijo)) <> v_prefijo
           OR position('/' IN substr(v_ruta #>> '{}', length(v_prefijo) + 1)) > 0
           OR char_length(v_ruta #>> '{}') > 300 THEN
          RAISE EXCEPTION 'ADJUNTO_INVALIDO' USING hint = 'Un voucher no pertenece a este expediente. Vuelve a subirlo.';
        END IF;
      END LOOP;
    ELSE
      v_ruta := p_adjuntos -> v_clave;
      IF jsonb_typeof(v_ruta) <> 'string' OR left(v_ruta #>> '{}', length(v_prefijo)) <> v_prefijo
         OR position('/' IN substr(v_ruta #>> '{}', length(v_prefijo) + 1)) > 0
         OR char_length(v_ruta #>> '{}') > 300 THEN
        RAISE EXCEPTION 'ADJUNTO_INVALIDO' USING hint = 'Un archivo no pertenece a este expediente. Vuelve a subirlo.';
      END IF;
    END IF;
  END LOOP;

  -- Si estaba observado, sigue observado hasta que se reenvíe (el estado no se toca).
  INSERT INTO public.gh_expedientes (solicitud, estado, datos, adjuntos, actualizado_por)
  VALUES (p_solicitud, 'borrador', p_datos, p_adjuntos, v_quien)
  ON CONFLICT (solicitud) DO UPDATE
    SET datos = excluded.datos, adjuntos = excluded.adjuntos,
        actualizado = now(), actualizado_por = excluded.actualizado_por;

  RETURN public.gh_expediente_ver(p_solicitud);
END;
$$;

CREATE OR REPLACE FUNCTION public.gh_expediente_enviar(p_solicitud uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s public.gh_lotes_solicitudes%ROWTYPE;
  x public.gh_expedientes%ROWTYPE;
  e text;
  v_falta text;
  v_quien text := coalesce(nullif(lower(auth.jwt() ->> 'email'), ''), 'sin-correo');
BEGIN
  -- 113_expediente_separacion
  IF NOT public.gh_expediente_puede(p_solicitud) THEN
    RAISE EXCEPTION 'SIN_PERMISO' USING errcode = '42501', hint = 'Este expediente no es tuyo.';
  END IF;
  SELECT * INTO s FROM public.gh_lotes_solicitudes WHERE id = p_solicitud FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOLICITUD_NO_EXISTE' USING hint = 'Esa separación no existe.';
  END IF;
  IF s.estado <> 'aprobada' THEN
    RAISE EXCEPTION 'SOLICITUD_NO_APROBADA' USING hint = 'El expediente se arma cuando la separación está aprobada.';
  END IF;
  SELECT estado INTO e FROM public.gh_lotes_estado WHERE proyecto = s.proyecto AND lote = s.lote FOR UPDATE;
  IF NOT public.gh_solicitud_vigente(p_solicitud) THEN
    RAISE EXCEPTION 'SEPARACION_NO_VIGENTE' USING hint = 'Esa separación ya no es la vigente del lote.';
  END IF;
  IF e = 'vendido' THEN
    RAISE EXCEPTION 'YA_VENDIDO' USING hint = 'El lote ya figura como vendido.';
  END IF;

  SELECT * INTO x FROM public.gh_expedientes WHERE solicitud = p_solicitud FOR UPDATE;
  IF FOUND AND x.estado = 'enviado' THEN
    RAISE EXCEPTION 'EXPEDIENTE_ENVIADO' USING hint = 'Ya está en Legal. Espera su respuesta.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.gh_separacion_etapas t WHERE t.solicitud = p_solicitud AND t.etapa = 'expediente_legal') THEN
    RAISE EXCEPTION 'ETAPA_YA_MARCADA' USING hint = 'El expediente ya figura enviado a Legal.';
  END IF;

  -- Sin fila guardada se valida contra un expediente vacío: sale el primer faltante.
  v_falta := public.gh_expediente_faltante(CASE WHEN x.solicitud IS NOT NULL THEN x.datos ELSE '{}'::jsonb END,
                                           CASE WHEN x.solicitud IS NOT NULL THEN x.adjuntos ELSE '{}'::jsonb END,
                                           s.forma_pago);
  IF v_falta IS NOT NULL THEN
    RAISE EXCEPTION 'EXPEDIENTE_INCOMPLETO' USING hint = v_falta;
  END IF;

  UPDATE public.gh_expedientes
     SET estado = 'enviado', enviado_en = now(), enviado_por = v_quien,
         observacion = NULL, observado_por = NULL, observado_en = NULL,
         actualizado = now(), actualizado_por = v_quien
   WHERE solicitud = p_solicitud;

  -- Directo (gh_etapa_marcar exige ser aprobador): la etapa y el historial, igual que ella.
  INSERT INTO public.gh_separacion_etapas (solicitud, etapa, por, nota)
  VALUES (p_solicitud, 'expediente_legal', v_quien, 'Expediente enviado');
  INSERT INTO public.gh_lotes_historial (proyecto, lote, tipo, etapa, motivo, detalle, solicitud, por)
  VALUES (s.proyecto, s.lote, 'etapa', 'expediente_legal', NULL, 'Expediente enviado', p_solicitud, v_quien);

  RETURN public.gh_expediente_ver(p_solicitud);
END;
$$;

CREATE OR REPLACE FUNCTION public.gh_expediente_observar(p_solicitud uuid, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s public.gh_lotes_solicitudes%ROWTYPE;
  x public.gh_expedientes%ROWTYPE;
  e text;
  v_motivo text := nullif(btrim(coalesce(p_motivo, '')), '');
  v_quien text := coalesce(nullif(lower(auth.jwt() ->> 'email'), ''), 'sin-correo');
BEGIN
  -- 113_expediente_separacion
  IF NOT coalesce(public.gh_es(ARRAY['dueno', 'legal']), false) THEN
    RAISE EXCEPTION 'SIN_PERMISO' USING errcode = '42501', hint = 'Solo Legal puede observar un expediente.';
  END IF;
  IF v_motivo IS NULL OR char_length(v_motivo) < 3 OR char_length(v_motivo) > 500 THEN
    RAISE EXCEPTION 'MOTIVO_REQUERIDO' USING hint = 'Escribe el motivo de la observación (de 3 a 500 letras).';
  END IF;
  SELECT * INTO s FROM public.gh_lotes_solicitudes WHERE id = p_solicitud FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOLICITUD_NO_EXISTE' USING hint = 'Esa separación no existe.';
  END IF;
  IF s.estado <> 'aprobada' THEN
    RAISE EXCEPTION 'SOLICITUD_NO_APROBADA' USING hint = 'El expediente se arma cuando la separación está aprobada.';
  END IF;
  SELECT estado INTO e FROM public.gh_lotes_estado WHERE proyecto = s.proyecto AND lote = s.lote FOR UPDATE;
  IF NOT public.gh_solicitud_vigente(p_solicitud) THEN
    RAISE EXCEPTION 'SEPARACION_NO_VIGENTE' USING hint = 'Esa separación ya no es la vigente del lote.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.gh_separacion_etapas t WHERE t.solicitud = p_solicitud AND t.etapa = 'contrato_listo') THEN
    RAISE EXCEPTION 'CONTRATO_YA_LISTO' USING hint = 'El contrato ya está listo: ya no se puede observar el expediente.';
  END IF;
  IF e = 'vendido' THEN
    RAISE EXCEPTION 'YA_VENDIDO' USING hint = 'El lote ya figura como vendido.';
  END IF;
  SELECT * INTO x FROM public.gh_expedientes WHERE solicitud = p_solicitud FOR UPDATE;
  IF NOT FOUND OR x.estado <> 'enviado' THEN
    RAISE EXCEPTION 'EXPEDIENTE_NO_ENVIADO' USING hint = 'Solo se puede observar un expediente que el asesor ya envió.';
  END IF;

  UPDATE public.gh_expedientes
     SET estado = 'observado', observacion = v_motivo, observado_por = v_quien, observado_en = now(),
         actualizado = now(), actualizado_por = v_quien
   WHERE solicitud = p_solicitud;

  -- Vuelve a "Separadas": se borra la etapa que marcó el envío.
  DELETE FROM public.gh_separacion_etapas WHERE solicitud = p_solicitud AND etapa = 'expediente_legal';
  INSERT INTO public.gh_lotes_historial (proyecto, lote, tipo, etapa, motivo, detalle, solicitud, por)
  VALUES (s.proyecto, s.lote, 'etapa', 'expediente_observado', v_motivo, v_motivo, p_solicitud, v_quien);

  RETURN public.gh_expediente_ver(p_solicitud);
END;
$$;

CREATE OR REPLACE FUNCTION public.gh_mis_separaciones()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  -- 113_expediente_separacion
  SELECT coalesce(jsonb_agg(f.fila ORDER BY f.orden DESC), '[]'::jsonb)
    FROM (
      SELECT coalesce(s.resuelta, s.creada) AS orden,
             jsonb_build_object(
               'solicitud', s.id,
               'proyecto', s.proyecto,
               'lote', s.lote,
               'cliente_nombre', s.cliente_nombre,
               'creada', s.creada,
               'resuelta', s.resuelta,
               'estado_lote', l.estado,
               'expediente_estado', coalesce(x.estado, 'nuevo'),
               'observacion', x.observacion,
               'etapas', coalesce((SELECT jsonb_agg(t.etapa ORDER BY t.cuando)
                                     FROM public.gh_separacion_etapas t WHERE t.solicitud = s.id), '[]'::jsonb)
             ) AS fila
        FROM public.gh_lotes_solicitudes s
        JOIN public.gh_lotes_estado l ON l.proyecto = s.proyecto AND l.lote = s.lote
        LEFT JOIN public.gh_expedientes x ON x.solicitud = s.id
       WHERE auth.uid() IS NOT NULL
         AND s.asesor_uid = auth.uid()
         AND s.estado = 'aprobada'
         AND public.gh_solicitud_vigente(s.id)
       ORDER BY coalesce(s.resuelta, s.creada) DESC
       LIMIT 100
    ) f;
$$;

-- ============================================================
-- 5. gh_separaciones_panel: igual que la 098 + expediente_estado y expediente_observacion
-- ============================================================
CREATE OR REPLACE FUNCTION public.gh_separaciones_panel()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  completo boolean;
  r jsonb;
begin
  -- 113_expediente_separacion
  if not public.gh_es_equipo_interno() then
    raise exception 'SIN_PERMISO' using errcode = '42501',
      hint = 'Esta lista es sólo del equipo interno.';
  end if;
  completo := coalesce(public.gh_puede_resolver(), false)
           or coalesce(public.gh_es(array['dueno', 'legal', 'cobranzas', 'ventas']), false);

  select coalesce(jsonb_agg(x.fila order by x.creada desc), '[]'::jsonb) into r
    from (
      select s.creada,
             (case when completo then to_jsonb(s)
                   else to_jsonb(s) - 'cliente_documento' - 'cliente_telefono' - 'cliente_correo'
                                    - 'voucher_path' - 'operacion' - 'banco' - 'medio_pago' end)
             - 'asesor_uid'
             || jsonb_build_object(
                  'estado_lote', e.estado,
                  'separado_desde', e.separado_desde,
                  'lote_actualizado', e.actualizado,
                  'resuelta_por_nombre', (select q.nombre from gh_equipo q where q.correo = s.resuelta_por),
                  'expediente_estado', coalesce(ex.estado, 'nuevo'),
                  'expediente_observacion', ex.observacion,
                  'etapas', coalesce((
                    select jsonb_agg(jsonb_build_object(
                             'etapa', t.etapa, 'resultado', t.resultado, 'por', t.por,
                             'por_nombre', q.nombre, 'cuando', t.cuando, 'nota', t.nota)
                           order by t.cuando)
                      from gh_separacion_etapas t
                      left join gh_equipo q on q.correo = t.por
                     where t.solicitud = s.id), '[]'::jsonb)
                ) as fila
        from gh_lotes_solicitudes s
        join gh_lotes_estado e on e.proyecto = s.proyecto and e.lote = s.lote
        left join gh_expedientes ex on ex.solicitud = s.id
       where s.estado in ('pendiente', 'aprobada')
         and public.gh_solicitud_vigente(s.id)
       order by s.creada desc
       limit 400
    ) x;
  return r;
end;
$function$;

-- ============================================================
-- 6. Permisos de funciones, una por una
-- ============================================================
ALTER FUNCTION public.gh_expediente_num(jsonb) OWNER TO postgres;
ALTER FUNCTION public.gh_expediente_txt(jsonb, text[]) OWNER TO postgres;
ALTER FUNCTION public.gh_expediente_fecha_ok(jsonb) OWNER TO postgres;
ALTER FUNCTION public.gh_expediente_sugeridos(uuid) OWNER TO postgres;
ALTER FUNCTION public.gh_expediente_ver(uuid) OWNER TO postgres;
ALTER FUNCTION public.gh_expediente_faltante(jsonb, jsonb, text) OWNER TO postgres;
ALTER FUNCTION public.gh_expediente_puede(uuid) OWNER TO postgres;
ALTER FUNCTION public.gh_expediente_puede_ruta(text) OWNER TO postgres;
ALTER FUNCTION public.gh_expediente_abrir(uuid) OWNER TO postgres;
ALTER FUNCTION public.gh_expediente_guardar(uuid, jsonb, jsonb) OWNER TO postgres;
ALTER FUNCTION public.gh_expediente_enviar(uuid) OWNER TO postgres;
ALTER FUNCTION public.gh_expediente_observar(uuid, text) OWNER TO postgres;
ALTER FUNCTION public.gh_mis_separaciones() OWNER TO postgres;

REVOKE ALL ON FUNCTION
  public.gh_expediente_num(jsonb), public.gh_expediente_txt(jsonb, text[]), public.gh_expediente_fecha_ok(jsonb),
  public.gh_expediente_sugeridos(uuid), public.gh_expediente_ver(uuid), public.gh_expediente_faltante(jsonb, jsonb, text),
  public.gh_expediente_puede(uuid), public.gh_expediente_puede_ruta(text),
  public.gh_expediente_abrir(uuid), public.gh_expediente_guardar(uuid, jsonb, jsonb),
  public.gh_expediente_enviar(uuid), public.gh_expediente_observar(uuid, text), public.gh_mis_separaciones(),
  public.gh_lotes_al_solicitar(), public.gh_separaciones_panel()
  FROM PUBLIC, anon, authenticated;

-- Los ayudantes internos (num, txt, fecha_ok, sugeridos, ver, faltante) quedan sin ningún permiso.
-- puede y puede_ruta: las reglas de archivos corren con los permisos de quien sube o mira.
GRANT EXECUTE ON FUNCTION public.gh_expediente_puede(uuid), public.gh_expediente_puede_ruta(text) TO authenticated;
GRANT EXECUTE ON FUNCTION
  public.gh_expediente_abrir(uuid), public.gh_expediente_guardar(uuid, jsonb, jsonb),
  public.gh_expediente_enviar(uuid), public.gh_expediente_observar(uuid, text), public.gh_mis_separaciones(),
  public.gh_separaciones_panel()
  TO authenticated;
-- gh_lotes_al_solicitar es disparador: sin permiso para la API (como en la 098).

-- ============================================================
-- 7. Carpeta privada 'expedientes' y sus reglas
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('expedientes', 'expedientes', false, 6291456,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = 6291456,
      allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];

DROP POLICY IF EXISTS "expedientes subir" ON storage.objects;
DROP POLICY IF EXISTS "expedientes ver" ON storage.objects;
CREATE POLICY "expedientes subir" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'expedientes' AND public.gh_expediente_puede_ruta(name));
CREATE POLICY "expedientes ver" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'expedientes' AND public.gh_expediente_puede_ruta(name));
-- Sin update ni delete: lo subido no se pisa ni se borra desde la app.

COMMIT;
