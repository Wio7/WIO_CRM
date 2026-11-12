-- ============================================================
-- 093_estado_cuenta_banco.sql — Estado de cuenta de la Caja Ica (Fase F5)
--
-- Casos: supabase/tests/093_casos.sql (correr DESPUÉS de aplicar esta).
-- Requiere: 084 (installment_payments, has_full_access, can_access_module,
-- is_account_member) y 092 (área 'administracion').
--
-- La app de Administración sube el .xls del banco, lo lee en el navegador y
-- manda las filas ya clasificadas a import_bank_statement. Aquí se guardan
-- los movimientos para conciliarlos con el libro de pagos del ERP.
--
-- SOLO CREA objetos con nombre nuevo. NO reemplaza ninguna función, policy,
-- vista ni tabla que ya exista (la base real se desvía de las migraciones del
-- repo; por eso esta migración no toca can_access_module, set_member_area ni
-- nada de 084/092: solo las LEE).
--
-- Tablas (nuevas):
--   public.bank_statement_imports     una fila por archivo subido
--   public.bank_statement_movements   un movimiento del banco; `huella` única
--                                     por cuenta evita duplicar al reimportar
-- Funciones (nuevas, ninguna existe en producción):
--   public.bank_statement_access(uuid)               quién ve y escribe esto
--   public.import_bank_statement(jsonb)              importa; ignora duplicados
--   public.set_movement_match(uuid, text, uuid, text)  concilia / marca un movimiento
--   public.set_movement_matches(jsonb)               lo mismo en lote (conciliación automática)
-- Índices y policies: los de esas dos tablas (ver abajo).
--
-- Quién entra (bank_statement_access): can_access_module(cuenta,'cobranzas')
-- (la versión vigente, 092) Y además dueño / super admin, o área
-- administración, contabilidad o gerencia. El área 'cobranzas' abre el módulo
-- de cobranzas pero NO ve el estado de cuenta del banco.
-- Las tablas son de solo lectura para los usuarios: escriben los RPC.
--
-- Idempotente — se puede volver a correr.
-- ============================================================
BEGIN;

-- ============================================================
-- 1. Acceso
-- ============================================================
CREATE OR REPLACE FUNCTION public.bank_statement_access(p_account uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND p_account IS NOT NULL
     AND public.can_access_module(p_account, 'cobranzas')
     AND (
       public.has_full_access(p_account)
       OR EXISTS (
         SELECT 1 FROM public.profiles p
          WHERE p.user_id = auth.uid()
            AND p.account_id = p_account
            AND p.area IN ('administracion', 'contabilidad', 'gerencia'))
     );
$$;
ALTER FUNCTION public.bank_statement_access(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.bank_statement_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_statement_access(uuid) TO authenticated, service_role;

-- ============================================================
-- 2. Archivos importados
-- ============================================================
CREATE TABLE IF NOT EXISTS public.bank_statement_imports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  banco            text NOT NULL DEFAULT 'caja_ica' CHECK (banco IN ('caja_ica')),
  cuenta           text,
  periodo_desde    date,
  periodo_hasta    date,
  archivo          text,
  importado_por    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  importado_en     timestamptz NOT NULL DEFAULT now(),
  filas            integer NOT NULL DEFAULT 0,
  filas_nuevas     integer NOT NULL DEFAULT 0,
  total_depositos  numeric(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bank_statement_imports_account
  ON public.bank_statement_imports(account_id, importado_en DESC);

-- ============================================================
-- 3. Movimientos
-- ============================================================
CREATE TABLE IF NOT EXISTS public.bank_statement_movements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  import_id     uuid REFERENCES public.bank_statement_imports(id) ON DELETE SET NULL,
  banco         text NOT NULL DEFAULT 'caja_ica' CHECK (banco IN ('caja_ica')),
  cuenta        text,
  -- Hora de Lima (UTC-5) como la trae el banco; `fecha` es el día en Lima.
  fecha_hora    timestamptz NOT NULL,
  fecha         date NOT NULL,
  descripcion   text NOT NULL,
  tipo          text NOT NULL CHECK (tipo IN ('convenio', 'interbancaria', 'app', 'efectivo', 'comision', 'otro')),
  -- Traspaso entre cuentas propias: entra a la caja pero no es abono de cliente.
  propio        boolean NOT NULL DEFAULT false,
  deposito      numeric(12,2) NOT NULL DEFAULT 0 CHECK (deposito >= 0),
  -- Siempre positivo (el archivo del banco lo trae en negativo).
  retiro        numeric(12,2) NOT NULL DEFAULT 0 CHECK (retiro >= 0),
  saldo         numeric(14,2),
  agencia       text,
  huella        text NOT NULL,
  payment_id    uuid REFERENCES public.installment_payments(id) ON DELETE NO ACTION,
  estado        text NOT NULL DEFAULT 'por_conciliar'
                CHECK (estado IN ('por_conciliar', 'conciliado', 'no_es_cuota', 'revisar')),
  nota          text,
  conciliado_por uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  conciliado_en timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_statement_movements_huella_unica UNIQUE (account_id, huella),
  CONSTRAINT bank_statement_movements_pago_si_conciliado CHECK ((estado = 'conciliado') = (payment_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_bank_statement_movements_fecha
  ON public.bank_statement_movements(account_id, fecha_hora DESC);
CREATE INDEX IF NOT EXISTS idx_bank_statement_movements_estado
  ON public.bank_statement_movements(account_id, estado);
-- Un pago del ERP respalda a un solo movimiento del banco.
CREATE UNIQUE INDEX IF NOT EXISTS bank_statement_movements_un_pago
  ON public.bank_statement_movements(payment_id) WHERE payment_id IS NOT NULL;

-- ============================================================
-- 4. RLS: solo lectura para usuarios; escriben los RPC (dueño postgres)
-- ============================================================
ALTER TABLE public.bank_statement_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_statement_movements ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.bank_statement_imports FROM anon;
REVOKE ALL ON public.bank_statement_movements FROM anon;
REVOKE ALL ON public.bank_statement_imports FROM authenticated;
REVOKE ALL ON public.bank_statement_movements FROM authenticated;
GRANT SELECT ON public.bank_statement_imports TO authenticated;
GRANT SELECT ON public.bank_statement_movements TO authenticated;

DROP POLICY IF EXISTS bank_statement_imports_select ON public.bank_statement_imports;
CREATE POLICY bank_statement_imports_select ON public.bank_statement_imports FOR SELECT
  USING (public.bank_statement_access(account_id));

DROP POLICY IF EXISTS bank_statement_movements_select ON public.bank_statement_movements;
CREATE POLICY bank_statement_movements_select ON public.bank_statement_movements FOR SELECT
  USING (public.bank_statement_access(account_id));

-- ============================================================
-- 5. import_bank_statement(jsonb)
--
-- p_payload = {
--   "banco": "caja_ica", "cuenta": "108...", "archivo": "Estado de Cuenta - ....xls",
--   "periodo_desde": "2026-10-01", "periodo_hasta": "2026-10-31",
--   "filas": [ { "fecha_hora": "2026-10-01T07:11:20-05:00", "descripcion": "...",
--                "tipo": "interbancaria", "propio": false, "deposito": 289.12,
--                "retiro": 0, "saldo": 37232.04, "agencia": "Libertad",
--                "huella": "...", "estado": "por_conciliar" } ]
-- }
-- La cuenta de la app es la del que llama. Las filas con una huella ya
-- guardada se ignoran. Devuelve { import_id, filas, nuevos, duplicados }.
-- ============================================================
CREATE OR REPLACE FUNCTION public.import_bank_statement(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  IF v_account IS NULL OR NOT public.bank_statement_access(v_account) THEN
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

-- ============================================================
-- 6. set_movement_match(...)
--
-- Cambia el estado de UN movimiento. 'conciliado' pide el pago del ERP
-- (de la misma cuenta, no anulado) y un depósito; cualquier otro estado
-- quita el enlace. No toca el libro de pagos: no cambia la lógica de 084.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_movement_match(
  p_movement_id uuid,
  p_estado      text,
  p_payment_id  uuid DEFAULT NULL,
  p_nota        text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mov public.bank_statement_movements%ROWTYPE;
  v_pay public.installment_payments%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_mov FROM public.bank_statement_movements WHERE id = p_movement_id FOR UPDATE;
  IF NOT FOUND OR NOT public.bank_statement_access(v_mov.account_id) THEN
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
-- 7. set_movement_matches(jsonb): lote para la conciliación automática
-- p_items = [ { "movement_id": "...", "estado": "conciliado|revisar|...", "payment_id": "..." | null } ]
-- Todo o nada (una sola transacción). Devuelve cuántos cambió.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_movement_matches(p_items jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_n integer := 0;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'items debe ser una lista' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_items) > 2000 THEN
    RAISE EXCEPTION 'Demasiados movimientos en un lote (máximo 2000)' USING ERRCODE = '22023';
  END IF;
  FOR r IN
    SELECT * FROM jsonb_to_recordset(p_items) AS x(movement_id uuid, estado text, payment_id uuid, nota text)
  LOOP
    PERFORM public.set_movement_match(r.movement_id, r.estado, r.payment_id, r.nota);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;
ALTER FUNCTION public.set_movement_matches(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_movement_matches(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_movement_matches(jsonb) TO authenticated;

COMMIT;

-- PostgREST lee el esquema nuevo sin reiniciar.
NOTIFY pgrst, 'reload schema';
