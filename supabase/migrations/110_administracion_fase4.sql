-- ============================================================
-- 110_administracion_fase4.sql — Estado de cuenta de solo lectura para contabilidad,
-- lista de contratos en firma para contabilidad, lista de verificación del contrato
-- y cajas de gerencia (El Hato, Efectivo Eric, Caja Grande)
-- WIO_CRM main. Correr en el SQL Editor de wioCRM (WioSuite).
--
-- Qué cambia:
--   1. Estado de cuenta del banco (093). Contabilidad sigue LEYENDO los movimientos
--      (bank_statement_access no cambia), pero ya no puede importar ni conciliar.
--        - Nueva bank_statement_write_access(cuenta): igual que bank_statement_access,
--          pero las áreas son solo 'administracion' y 'gerencia' (más has_full_access).
--        - import_bank_statement y set_movement_match (la 093) ahora piden esa.
--          set_movement_matches llama a set_movement_match, así que hereda la regla
--          sin tocarla. Firmas y comportamiento iguales; solo cambia el permiso y
--          el search_path pasa a 'public, pg_temp'.
--   2. Contratos en firma (102). contratos_en_firma_lista ahora también la puede
--      llamar contabilidad (flujo_rol / flujo_exigir de la 101 ya aceptan esa área:
--      no hizo falta tocarlas). Registrar legalización y verificar siguen sin
--      contabilidad. Cada item suma la clave 'verificacion' (jsonb o null); las
--      claves que ya tenía no cambian.
--   3. Lista de verificación del contrato:
--        - Tabla contrato_verificaciones (una fila por solicitud; sin políticas,
--          sin GRANT: solo se llega por funciones, como contrato_legalizaciones).
--        - contrato_verificacion_completa(...): función pura que dice si está completo.
--        - contrato_verificar(solicitud, datos): administración y gerencia; crea o
--          actualiza la fila, deja huella en erp_audit_events y devuelve el jsonb.
--        - contrato_verificacion_json(...): ayudante interno (sin GRANT).
--   4. Cajas de gerencia (solo la cuenta Golden Habitat):
--        - 'La Jato · Hacienda' pasa a llamarse 'El Hato' (si 'El Hato' no existe).
--        - Se crean 'Efectivo Eric' y 'Caja Grande' si faltan.
--        - Columna cash_companies.solo_duenos (true para 'Efectivo Eric').
--        - cash_panel_companies (094): una caja solo_duenos aparece solo para quienes
--          están en cash_owners de la cuenta (o tienen rol 'owner' en esa caja). El área
--          gerencia deja de ver Efectivo Eric. 095 y 097 usan esa función y no cambian.
--      Las altas en cash_companies funcionan desde el SQL Editor (auth.uid() NULL): el
--      único trigger de esa tabla (087, responsable por defecto) no usa auth.uid(),
--      y el trigger de auditoría que sí lo pide (cash_entry_audit_trigger) es de
--      cash_entries, que esta migración no toca. No se desactiva ningún trigger.
--
-- Requiere (la migración se detiene con un mensaje claro si falta algo): 092, 093, 094,
-- 099 (erp_audit_log), 101 (flujo_*), 102 (contrato_legalizaciones), la Golden App 098
-- (gh_lotes_solicitudes) y la Golden Caja 065/069/074 (cash_companies, cash_owners,
-- cash_company_role).
--
-- ANTES de aplicar, comprobar a mano que las funciones vivas son las del repo (la
-- migración lo comprueba sola, esto es para verlo antes de correrla). La huella es el
-- md5 del cuerpo SIN espacios ni saltos de línea (así no importa CRLF/LF):
--   SELECT p.proname, md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p
--    WHERE p.pronamespace = 'public'::regnamespace
--      AND p.proname IN ('import_bank_statement', 'set_movement_match',
--                        'contratos_en_firma_lista', 'cash_panel_companies');
--   Deben salir:
--     import_bank_statement     95c1826543b1847f39c9b40468eb9757  (093)
--     set_movement_match        f3e79fde95f9987719145c4537d714e5  (093)
--     contratos_en_firma_lista  8c23879e5744b66064dac060edea6d91  (102)
--     cash_panel_companies      3bbe67f192252976e0052c67e51b636a  (094)
--   Si ya corrió la 110, el cuerpo lleva la marca '110_administracion_fase4' y también pasa.
--   Si no coinciden, NO aplicar: la base real se desvía del repo.
--
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
    FROM unnest(ARRAY['accounts', 'profiles', 'gh_lotes_solicitudes', 'contrato_legalizaciones',
                      'cash_companies', 'cash_owners', 'bank_statement_movements']) AS t
   WHERE to_regclass('public.' || t) IS NULL;
  IF v_faltan IS NOT NULL THEN
    RAISE EXCEPTION 'FALTAN_TABLAS_PARA_LA_110: % (aplicar antes 093, 098, 102 y la Golden Caja 065/069)', v_faltan;
  END IF;

  SELECT string_agg(t, ', ') INTO v_faltan
    FROM unnest(ARRAY['bank_statement_access(uuid)', 'can_access_module(uuid,text)', 'has_full_access(uuid)',
                      'flujo_exigir(text[],text)', 'flujo_rol()', 'flujo_cuenta()',
                      'flujo_nombre()', 'flujo_audit(text,text,text,text,jsonb)', 'flujo_texto(text,text,integer,integer)',
                      'flujo_app(text)', 'gh_entregas_cuenta()', 'gh_solicitud_vigente(uuid)', 'is_owner_or_gerencia(uuid)',
                      'cash_company_role(uuid)']) AS t
   WHERE to_regprocedure('public.' || t) IS NULL;
  IF v_faltan IS NOT NULL THEN
    RAISE EXCEPTION 'FALTAN_FUNCIONES_PARA_LA_110: % (aplicar antes 092, 093, 098, 101 y 102)', v_faltan;
  END IF;

  FOR f IN SELECT * FROM (VALUES
      ('import_bank_statement(jsonb)',                  '95c1826543b1847f39c9b40468eb9757'),
      ('set_movement_match(uuid,text,uuid,text)',       'f3e79fde95f9987719145c4537d714e5'),
      ('contratos_en_firma_lista(integer,integer)',     '8c23879e5744b66064dac060edea6d91'),
      ('cash_panel_companies(uuid)',                    '3bbe67f192252976e0052c67e51b636a')
    ) AS v(firma, huella)
  LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || f.firma);
    IF v_src IS NULL THEN
      RAISE EXCEPTION 'FALTA_FUNCION_PARA_LA_110: public.% no existe', f.firma;
    END IF;
    IF position('110_administracion_fase4' IN v_src) = 0
       AND md5(regexp_replace(v_src, '\s', '', 'g')) <> f.huella THEN
      RAISE EXCEPTION 'HUELLA_DISTINTA: public.% no es la del repo (md5 vivo %, esperado %). La base real se desvía: NO aplicar la 110 hasta revisarla.',
        f.firma, md5(regexp_replace(v_src, '\s', '', 'g')), f.huella;
    END IF;
  END LOOP;
END
$$;

-- ============================================================
-- 1. Estado de cuenta del banco: contabilidad solo lee
-- ============================================================
CREATE OR REPLACE FUNCTION public.bank_statement_write_access(p_account uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT auth.uid() IS NOT NULL AND p_account IS NOT NULL
     AND public.can_access_module(p_account, 'cobranzas')
     AND (
       public.has_full_access(p_account)
       OR EXISTS (
         SELECT 1 FROM public.profiles p
          WHERE p.user_id = auth.uid()
            AND p.account_id = p_account
            AND p.area IN ('administracion', 'gerencia'))
     );
$$;
ALTER FUNCTION public.bank_statement_write_access(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.bank_statement_write_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_statement_write_access(uuid) TO authenticated;

-- import_bank_statement (093): igual, pero exige escritura.
CREATE OR REPLACE FUNCTION public.import_bank_statement(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- 110_administracion_fase4: exige bank_statement_write_access (escritura solo administración y gerencia).
DECLARE
  v_account uuid;
  v_filas   jsonb := COALESCE(p_payload -> 'filas', '[]'::jsonb);
  v_import  uuid;
  v_total   integer;
  v_nuevos  integer;
  v_banco   text := COALESCE(NULLIF(p_payload ->> 'banco', ''), 'caja_ica');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT account_id INTO v_account FROM public.profiles WHERE user_id = auth.uid();
  IF v_account IS NULL OR NOT public.bank_statement_write_access(v_account) THEN
    RAISE EXCEPTION 'Sin acceso al estado de cuenta del banco' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_filas) <> 'array' THEN
    RAISE EXCEPTION 'filas debe ser una lista' USING ERRCODE = '22023';
  END IF;
  v_total := jsonb_array_length(v_filas);
  IF v_total = 0 THEN
    RAISE EXCEPTION 'El estado de cuenta no trae movimientos' USING ERRCODE = '22023';
  END IF;
  IF v_total > 5000 THEN
    RAISE EXCEPTION 'Demasiados movimientos en un archivo (máximo 5000)' USING ERRCODE = '22023';
  END IF;
  IF v_banco <> 'caja_ica' THEN
    RAISE EXCEPTION 'Banco no soportado: %', v_banco USING ERRCODE = '22023';
  END IF;

  -- Al importar solo se aceptan estados iniciales: nada llega "conciliado" sin pago.
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(v_filas) AS r(estado text)
     WHERE COALESCE(r.estado, 'por_conciliar') NOT IN ('por_conciliar', 'no_es_cuota')
  ) THEN
    RAISE EXCEPTION 'Estado inicial no válido en el archivo' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.bank_statement_imports
    (account_id, banco, cuenta, periodo_desde, periodo_hasta, archivo, importado_por, filas, total_depositos)
  SELECT v_account, v_banco, NULLIF(p_payload ->> 'cuenta', ''),
         NULLIF(p_payload ->> 'periodo_desde', '')::date, NULLIF(p_payload ->> 'periodo_hasta', '')::date,
         NULLIF(p_payload ->> 'archivo', ''), auth.uid(), v_total,
         COALESCE((SELECT sum(COALESCE(r.deposito, 0)) FROM jsonb_to_recordset(v_filas) AS r(deposito numeric)), 0)
  RETURNING id INTO v_import;

  WITH ins AS (
    INSERT INTO public.bank_statement_movements
      (account_id, import_id, banco, cuenta, fecha_hora, fecha, descripcion, tipo, propio,
       deposito, retiro, saldo, agencia, huella, estado)
    SELECT v_account, v_import, v_banco, NULLIF(p_payload ->> 'cuenta', ''),
           r.fecha_hora, (r.fecha_hora AT TIME ZONE 'America/Lima')::date, r.descripcion, r.tipo,
           COALESCE(r.propio, false), COALESCE(r.deposito, 0), COALESCE(r.retiro, 0), r.saldo,
           NULLIF(r.agencia, ''), r.huella, COALESCE(r.estado, 'por_conciliar')
      FROM jsonb_to_recordset(v_filas) AS r(
        fecha_hora timestamptz, descripcion text, tipo text, propio boolean,
        deposito numeric, retiro numeric, saldo numeric, agencia text, huella text, estado text)
    ON CONFLICT (account_id, huella) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_nuevos FROM ins;

  UPDATE public.bank_statement_imports SET filas_nuevas = v_nuevos WHERE id = v_import;

  RETURN jsonb_build_object('import_id', v_import, 'filas', v_total, 'nuevos', v_nuevos, 'duplicados', v_total - v_nuevos);
END;
$$;
ALTER FUNCTION public.import_bank_statement(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.import_bank_statement(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_bank_statement(jsonb) TO authenticated;

-- set_movement_match (093): igual, pero exige escritura. set_movement_matches (lote) la llama.
CREATE OR REPLACE FUNCTION public.set_movement_match(
  p_movement_id uuid,
  p_estado      text,
  p_payment_id  uuid DEFAULT NULL,
  p_nota        text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- 110_administracion_fase4: exige bank_statement_write_access (escritura solo administración y gerencia).
DECLARE
  v_mov public.bank_statement_movements%ROWTYPE;
  v_pay public.installment_payments%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_mov FROM public.bank_statement_movements WHERE id = p_movement_id FOR UPDATE;
  IF NOT FOUND OR NOT public.bank_statement_write_access(v_mov.account_id) THEN
    RAISE EXCEPTION 'Movimiento no encontrado' USING ERRCODE = '42501';
  END IF;
  IF p_estado IS NULL OR p_estado NOT IN ('por_conciliar', 'conciliado', 'no_es_cuota', 'revisar') THEN
    RAISE EXCEPTION 'Estado no válido: %', COALESCE(p_estado, 'vacío') USING ERRCODE = '22023';
  END IF;

  IF p_estado = 'conciliado' THEN
    IF p_payment_id IS NULL THEN
      RAISE EXCEPTION 'Para conciliar hay que indicar el pago del ERP' USING ERRCODE = '22023';
    END IF;
    IF v_mov.deposito <= 0 THEN
      RAISE EXCEPTION 'Solo un depósito se concilia con un pago' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_pay FROM public.installment_payments WHERE id = p_payment_id;
    IF NOT FOUND OR v_pay.account_id <> v_mov.account_id THEN
      RAISE EXCEPTION 'Pago no encontrado' USING ERRCODE = '22023';
    END IF;
    IF v_pay.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'Ese pago está anulado' USING ERRCODE = '22023';
    END IF;
  ELSIF p_payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'Solo un movimiento conciliado lleva pago' USING ERRCODE = '22023';
  END IF;

  BEGIN
    UPDATE public.bank_statement_movements
       SET estado = p_estado,
           payment_id = CASE WHEN p_estado = 'conciliado' THEN p_payment_id ELSE NULL END,
           nota = COALESCE(p_nota, nota),
           conciliado_por = CASE WHEN p_estado = 'conciliado' THEN auth.uid() ELSE NULL END,
           conciliado_en = CASE WHEN p_estado = 'conciliado' THEN now() ELSE NULL END
     WHERE id = p_movement_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Ese pago ya está enlazado a otro movimiento del banco' USING ERRCODE = '23505';
  END;
END;
$$;
ALTER FUNCTION public.set_movement_match(uuid, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_movement_match(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_movement_match(uuid, text, uuid, text) TO authenticated;

-- ============================================================
-- 2. Lista de verificación del contrato
-- ============================================================
CREATE TABLE IF NOT EXISTS public.contrato_verificaciones (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  solicitud             uuid NOT NULL UNIQUE REFERENCES public.gh_lotes_solicitudes(id) ON DELETE CASCADE,
  tipo                  text NOT NULL DEFAULT 'lote' CHECK (tipo IN ('lote', 'casa')),
  juegos_firmados       smallint NOT NULL DEFAULT 0 CHECK (juegos_firmados BETWEEN 0 AND 3),
  huella                boolean NOT NULL DEFAULT false,
  anexo_cronograma      boolean NOT NULL DEFAULT false,
  ficha_tecnica_rubi    boolean NOT NULL DEFAULT false,
  nota                  text CHECK (nota IS NULL OR length(nota) <= 500),
  verificado_por        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  verificado_por_nombre text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contrato_verificaciones_por_cuenta
  ON public.contrato_verificaciones (account_id, updated_at DESC);

ALTER TABLE public.contrato_verificaciones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contrato_verificaciones FROM PUBLIC, anon, authenticated;
-- Sin políticas y sin GRANT: nadie lee ni escribe directo.

-- Completo = 3 juegos firmados + huella + (anexo del cronograma si es lote; ficha técnica Rubí si es casa).
CREATE OR REPLACE FUNCTION public.contrato_verificacion_completa(
  p_tipo text, p_juegos smallint, p_huella boolean, p_anexo boolean, p_ficha boolean)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(
    p_juegos = 3 AND p_huella AND (CASE p_tipo WHEN 'lote' THEN p_anexo ELSE p_ficha END),
    false);
$$;

-- Ayudante interno: arma el jsonb de la verificación (lo usan contrato_verificar y la lista).
CREATE OR REPLACE FUNCTION public.contrato_verificacion_json(
  p_tipo text, p_juegos smallint, p_huella boolean, p_anexo boolean, p_ficha boolean,
  p_nota text, p_nombre text, p_updated timestamptz)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'tipo', p_tipo, 'juegos_firmados', p_juegos, 'huella', p_huella,
    'anexo_cronograma', p_anexo, 'ficha_tecnica_rubi', p_ficha, 'nota', p_nota,
    'verificado_por_nombre', p_nombre, 'updated_at', p_updated,
    'completo', public.contrato_verificacion_completa(p_tipo, p_juegos, p_huella, p_anexo, p_ficha));
$$;

-- p_datos: objeto con cualquiera de tipo, juegos_firmados, huella, anexo_cronograma,
-- ficha_tecnica_rubi, nota. Lo que no venga se queda como estaba (o en su valor por defecto
-- si la fila es nueva). Una nota vacía la borra.
CREATE OR REPLACE FUNCTION public.contrato_verificar(p_solicitud uuid, p_datos jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_rol    text;
  v_cuenta uuid;
  v_d      jsonb := COALESCE(p_datos, '{}'::jsonb);
  v_old    public.contrato_verificaciones;
  v_tipo   text;
  v_juegos smallint;
  v_huella boolean;
  v_anexo  boolean;
  v_ficha  boolean;
  v_nota   text;
  v_nombre text := public.flujo_nombre();
  k        text;
  r        public.contrato_verificaciones;
  v_nuevo  boolean;
BEGIN
  v_rol := public.flujo_exigir(ARRAY['administracion', 'gerencia'], 'Solo administración o gerencia');
  v_cuenta := public.flujo_cuenta();
  IF v_cuenta IS DISTINCT FROM public.gh_entregas_cuenta() THEN
    RAISE EXCEPTION 'Sin permiso para verificar contratos' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(v_d) <> 'object' THEN
    RAISE EXCEPTION 'Los datos deben ser un objeto' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.gh_lotes_solicitudes s WHERE s.id = p_solicitud AND s.estado = 'aprobada') THEN
    RAISE EXCEPTION 'La separación no existe o no está aprobada' USING ERRCODE = '22023';
  END IF;

  -- Validar los tipos antes de convertir nada.
  FOREACH k IN ARRAY ARRAY['huella', 'anexo_cronograma', 'ficha_tecnica_rubi'] LOOP
    IF v_d ? k AND jsonb_typeof(v_d -> k) NOT IN ('boolean', 'null') THEN
      RAISE EXCEPTION 'huella, anexo_cronograma y ficha_tecnica_rubi son verdadero o falso' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF v_d ? 'tipo' AND jsonb_typeof(v_d -> 'tipo') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'El tipo debe ser lote o casa' USING ERRCODE = '22023';
  END IF;
  IF v_d ? 'juegos_firmados' AND jsonb_typeof(v_d -> 'juegos_firmados') NOT IN ('number', 'null') THEN
    RAISE EXCEPTION 'Los juegos firmados van de 0 a 3' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_old FROM public.contrato_verificaciones x WHERE x.solicitud = p_solicitud FOR UPDATE;
  v_nuevo := NOT FOUND;

  v_tipo := COALESCE(NULLIF(v_d ->> 'tipo', ''), v_old.tipo, 'lote');
  IF v_tipo NOT IN ('lote', 'casa') THEN
    RAISE EXCEPTION 'El tipo debe ser lote o casa' USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(v_d -> 'juegos_firmados') = 'number' THEN
    IF (v_d ->> 'juegos_firmados')::numeric <> trunc((v_d ->> 'juegos_firmados')::numeric)
       OR (v_d ->> 'juegos_firmados')::numeric NOT BETWEEN 0 AND 3 THEN
      RAISE EXCEPTION 'Los juegos firmados van de 0 a 3' USING ERRCODE = '22023';
    END IF;
    v_juegos := (v_d ->> 'juegos_firmados')::smallint;
  ELSE
    v_juegos := COALESCE(v_old.juegos_firmados, 0);
  END IF;

  v_huella := COALESCE((v_d ->> 'huella')::boolean, v_old.huella, false);
  v_anexo  := COALESCE((v_d ->> 'anexo_cronograma')::boolean, v_old.anexo_cronograma, false);
  v_ficha  := COALESCE((v_d ->> 'ficha_tecnica_rubi')::boolean, v_old.ficha_tecnica_rubi, false);

  IF v_d ? 'nota' THEN
    v_nota := public.flujo_texto(v_d ->> 'nota', 'La nota', 0, 500);
  ELSE
    v_nota := v_old.nota;
  END IF;

  INSERT INTO public.contrato_verificaciones
    (account_id, solicitud, tipo, juegos_firmados, huella, anexo_cronograma, ficha_tecnica_rubi, nota,
     verificado_por, verificado_por_nombre)
  VALUES (v_cuenta, p_solicitud, v_tipo, v_juegos, v_huella, v_anexo, v_ficha, v_nota, auth.uid(), v_nombre)
  ON CONFLICT (solicitud) DO UPDATE
    SET tipo = EXCLUDED.tipo, juegos_firmados = EXCLUDED.juegos_firmados, huella = EXCLUDED.huella,
        anexo_cronograma = EXCLUDED.anexo_cronograma, ficha_tecnica_rubi = EXCLUDED.ficha_tecnica_rubi,
        nota = EXCLUDED.nota, verificado_por = EXCLUDED.verificado_por,
        verificado_por_nombre = EXCLUDED.verificado_por_nombre, updated_at = now()
  RETURNING * INTO r;

  PERFORM public.flujo_audit(public.flujo_app(v_rol), CASE WHEN v_nuevo THEN 'creo' ELSE 'edito' END,
    'contrato_verificacion', r.id::text,
    jsonb_build_object('solicitud', p_solicitud, 'tipo', r.tipo, 'juegos_firmados', r.juegos_firmados,
      'huella', r.huella, 'anexo_cronograma', r.anexo_cronograma, 'ficha_tecnica_rubi', r.ficha_tecnica_rubi,
      'completo', public.contrato_verificacion_completa(r.tipo, r.juegos_firmados, r.huella, r.anexo_cronograma, r.ficha_tecnica_rubi)));

  RETURN public.contrato_verificacion_json(r.tipo, r.juegos_firmados, r.huella, r.anexo_cronograma,
    r.ficha_tecnica_rubi, r.nota, r.verificado_por_nombre, r.updated_at);
END;
$$;

-- ============================================================
-- 3. Contratos en firma (102): también contabilidad, más la clave 'verificacion'
-- ============================================================
CREATE OR REPLACE FUNCTION public.contratos_en_firma_lista(p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
-- 110_administracion_fase4: suma contabilidad y la clave 'verificacion' de cada item.
DECLARE
  v_total integer;
  v_items jsonb;
  v_lim   integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_off   integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  PERFORM public.flujo_exigir(ARRAY['administracion', 'gerencia', 'legal', 'cobranzas', 'contabilidad'],
                              'Solo administración, gerencia, legal, cobranzas o contabilidad');
  IF public.flujo_cuenta() IS DISTINCT FROM public.gh_entregas_cuenta() THEN
    RAISE EXCEPTION 'Sin permiso para ver los contratos' USING ERRCODE = '42501';
  END IF;
  WITH b AS (
    SELECT s.id AS solicitud, s.proyecto, s.lote, s.cliente_nombre, s.asesor, fc.cuando AS firmado_cliente_at,
           GREATEST(0, (now() AT TIME ZONE 'America/Lima')::date - (fc.cuando AT TIME ZONE 'America/Lima')::date) AS dias,
           le.estado AS estado_lote, l.id AS leg_id, l.monto_centimos AS leg_monto, l.fecha AS leg_fecha,
           v.id AS ver_id, v.tipo AS ver_tipo, v.juegos_firmados AS ver_juegos, v.huella AS ver_huella,
           v.anexo_cronograma AS ver_anexo, v.ficha_tecnica_rubi AS ver_ficha, v.nota AS ver_nota,
           v.verificado_por_nombre AS ver_nombre, v.updated_at AS ver_updated
      FROM public.gh_separacion_etapas fc
      JOIN public.gh_lotes_solicitudes s ON s.id = fc.solicitud
      JOIN public.gh_lotes_estado le ON le.proyecto = s.proyecto AND le.lote = s.lote
      LEFT JOIN public.contrato_legalizaciones l ON l.solicitud = s.id
      LEFT JOIN public.contrato_verificaciones v ON v.solicitud = s.id
     WHERE fc.etapa = 'firmado_cliente'
       AND s.estado = 'aprobada'
       AND NOT EXISTS (SELECT 1 FROM public.gh_separacion_etapas fg WHERE fg.solicitud = s.id AND fg.etapa = 'firmado_gerencia')
       AND public.gh_solicitud_vigente(s.id)
  )
  SELECT (SELECT count(*) FROM b),
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'solicitud', t.solicitud, 'proyecto', t.proyecto, 'lote', t.lote, 'cliente_nombre', t.cliente_nombre,
                     'asesor', t.asesor, 'firmado_cliente_at', t.firmado_cliente_at, 'dias', t.dias,
                     'semaforo', CASE WHEN t.dias <= 4 THEN 'verde' WHEN t.dias <= 7 THEN 'ambar' ELSE 'rojo' END,
                     'estado_lote', t.estado_lote,
                     'legalizacion', jsonb_build_object('pagada', t.leg_id IS NOT NULL, 'monto_centimos', t.leg_monto, 'fecha', t.leg_fecha),
                     'verificacion', CASE WHEN t.ver_id IS NULL THEN NULL
                       ELSE public.contrato_verificacion_json(t.ver_tipo, t.ver_juegos, t.ver_huella, t.ver_anexo, t.ver_ficha,
                                                              t.ver_nota, t.ver_nombre, t.ver_updated) END)
                   ORDER BY t.dias DESC, t.firmado_cliente_at, t.solicitud)
                     FROM (SELECT * FROM b ORDER BY dias DESC, firmado_cliente_at, solicitud LIMIT v_lim OFFSET v_off) t), '[]'::jsonb)
    INTO v_total, v_items;
  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END;
$$;

-- ============================================================
-- 4. Cajas de gerencia (cuenta Golden Habitat)
-- ============================================================
ALTER TABLE public.cash_companies ADD COLUMN IF NOT EXISTS solo_duenos boolean NOT NULL DEFAULT false;

DO $$
DECLARE
  v_golden constant uuid := 'd74b5dfd-2999-4e2c-9a0e-10b3d540898b';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = v_golden) THEN
    RAISE NOTICE 'La cuenta Golden Habitat (%) no existe en esta base: se omiten las cajas de gerencia.', v_golden;
    RETURN;
  END IF;

  -- 'La Jato · Hacienda' pasa a 'El Hato' (solo si 'El Hato' todavía no existe).
  UPDATE public.cash_companies
     SET name = 'El Hato'
   WHERE account_id = v_golden AND name = 'La Jato · Hacienda'
     AND NOT EXISTS (SELECT 1 FROM public.cash_companies x WHERE x.account_id = v_golden AND x.name = 'El Hato');

  -- Cajas nuevas. El trigger de 087 deja a created_by como responsable; no usa auth.uid().
  INSERT INTO public.cash_companies (account_id, name, created_by, icon, sort_order)
  SELECT a.id, n.name, a.owner_user_id, n.icon,
         (SELECT COALESCE(max(c.sort_order), 0) FROM public.cash_companies c WHERE c.account_id = a.id) + n.ord
    FROM public.accounts a
   CROSS JOIN (VALUES ('Efectivo Eric', '💵', 1), ('Caja Grande', '🏦', 2)) AS n(name, icon, ord)
   WHERE a.id = v_golden
  ON CONFLICT (account_id, name) DO NOTHING;

  UPDATE public.cash_companies SET solo_duenos = true
   WHERE account_id = v_golden AND name = 'Efectivo Eric' AND NOT solo_duenos;
END
$$;

-- Cajas que el panel de gerencia muestra a quien lo abre (094 + solo_duenos).
CREATE OR REPLACE FUNCTION public.cash_panel_companies(p_account uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  -- 110_administracion_fase4: las cajas solo_duenos (Efectivo Eric) solo las ven los dueños de caja.
  SELECT c.id FROM public.cash_companies c
   WHERE c.account_id = p_account
     AND CASE WHEN c.solo_duenos
              THEN EXISTS (SELECT 1 FROM public.cash_owners o
                            WHERE o.account_id = p_account AND o.user_id = auth.uid())
                   OR public.cash_company_role(c.id) = 'owner'
              ELSE public.is_owner_or_gerencia(p_account)
                   OR c.id = p_account
                   OR public.cash_company_role(c.id) = 'owner'
         END;
$$;
ALTER FUNCTION public.cash_panel_companies(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cash_panel_companies(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_panel_companies(uuid) TO authenticated;

-- ============================================================
-- 5. Permisos de lo nuevo
-- ============================================================
DO $$
DECLARE
  f text;
BEGIN
  -- Interna: sin ningún GRANT.
  FOREACH f IN ARRAY ARRAY['public.contrato_verificacion_json(text,smallint,boolean,boolean,boolean,text,text,timestamptz)']
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
  -- Publicadas: solo authenticated.
  FOREACH f IN ARRAY ARRAY[
    'public.contrato_verificar(uuid,jsonb)',
    'public.contrato_verificacion_completa(text,smallint,boolean,boolean,boolean)',
    'public.contratos_en_firma_lista(integer,integer)']
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
