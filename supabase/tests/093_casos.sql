-- ============================================================
-- 093_casos.sql — Casos de la migración 093 (estado de cuenta de la Caja Ica)
--
-- Cómo correrlo: DESPUÉS de aplicar 093, pegar todo en el SQL Editor de
-- Supabase (corre como postgres). Cada caso es un DO que lanza
-- RAISE EXCEPTION 'FALLO ...' si algo no cuadra; si llega al final sin
-- error, imprime "093: todos los casos OK". Todo va dentro de una
-- transacción que termina en ROLLBACK: no deja datos.
--
-- Suplantación como en 092_casos.sql (set_config + SET LOCAL ROLE
-- authenticated; RESET ROLE vuelve a postgres). Prefijo de ids 0930c000-.
-- GUC: t093.acc, t093.acc2, t093.m1..m3.
--
-- Qué demuestra: Administración, Contabilidad, Gerencia y el dueño importan y
-- leen el estado de cuenta; Cobranzas (que sí abre el módulo de cobranzas),
-- Legal, Ventas, Promueve y quien no tiene área, NO. Reimportar el mismo
-- archivo no duplica. Conciliar enlaza un depósito con un pago del ERP (uno a
-- uno, no anulado). Los usuarios no escriben las tablas directo. Otra cuenta
-- no ve nada.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- Fixtures (como postgres)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_owner uuid := '0930c000-0000-4000-8000-000000000001';
  v_admin uuid := '0930c000-0000-4000-8000-000000000002';  -- administracion
  v_conta uuid := '0930c000-0000-4000-8000-000000000003';  -- contabilidad
  v_geren uuid := '0930c000-0000-4000-8000-000000000004';  -- gerencia
  v_cobra uuid := '0930c000-0000-4000-8000-000000000005';  -- cobranzas
  v_legal uuid := '0930c000-0000-4000-8000-000000000006';  -- legal
  v_vent  uuid := '0930c000-0000-4000-8000-000000000007';  -- ventas
  v_pro   uuid := '0930c000-0000-4000-8000-000000000008';  -- Promueve
  v_sin   uuid := '0930c000-0000-4000-8000-000000000009';  -- sin área
  v_own2  uuid := '0930c000-0000-4000-8000-00000000000a';  -- dueño de OTRA cuenta
  v_acc   uuid;
  v_acc2  uuid;
  v_today date := (now() AT TIME ZONE 'America/Lima')::date;
  r       record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (v_owner, 't093-owner@example.test'), (v_admin, 't093-admin@example.test'),
      (v_conta, 't093-conta@example.test'), (v_geren, 't093-geren@example.test'),
      (v_cobra, 't093-cobra@example.test'), (v_legal, 't093-legal@example.test'),
      (v_vent, 't093-vent@example.test'), (v_pro, 't093-pro@example.test'),
      (v_sin, 't093-sin@example.test'), (v_own2, 't093-own2@example.test')
    ) AS u(id, email)
  LOOP
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES (r.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            r.email, jsonb_build_object('full_name', r.email), now(), now());
  END LOOP;

  SELECT account_id INTO v_acc FROM public.profiles WHERE user_id = v_owner;
  IF v_acc IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Prueba 093', v_owner) RETURNING id INTO v_acc;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_owner, 'Dueño 093', 't093-owner@example.test', v_acc, 'owner');
  END IF;
  UPDATE public.accounts SET status = 'active' WHERE id = v_acc;

  SELECT account_id INTO v_acc2 FROM public.profiles WHERE user_id = v_own2;
  IF v_acc2 IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Otra cuenta 093', v_own2) RETURNING id INTO v_acc2;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_own2, 'Dueño 2 093', 't093-own2@example.test', v_acc2, 'owner');
  END IF;
  UPDATE public.accounts SET status = 'active' WHERE id = v_acc2;

  FOR r IN
    SELECT * FROM (VALUES
      (v_admin, 'administracion', 'Administración 093'),
      (v_conta, 'contabilidad', 'Conta 093'),
      (v_geren, 'gerencia', 'Gerencia 093'),
      (v_cobra, 'cobranzas', 'Cobranzas 093'),
      (v_legal, 'legal', 'Legal 093'),
      (v_vent,  'ventas', 'Ventas 093'),
      (v_pro,   'promueve', 'Externo 093'),
      (v_sin,   NULL::text, 'Sin área 093')
    ) AS m(id, area, full_name)
  LOOP
    UPDATE public.profiles SET account_id = v_acc, account_role = 'agent', area = r.area, full_name = r.full_name
     WHERE user_id = r.id;
    IF NOT FOUND THEN
      INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, area)
      VALUES (r.id, r.full_name, r.id::text || '@example.test', v_acc, 'agent', r.area);
    END IF;
  END LOOP;

  INSERT INTO public.contacts (id, account_id, user_id, phone, name)
  VALUES ('0930c000-0000-4000-8000-000000000301', v_acc, v_owner, '+51900093093', 'Cliente 093');

  INSERT INTO public.payment_plans (id, account_id, contact_id, currency, total_amount, down_payment,
                                    installments_count, monthly_amount, due_day, first_due_date, status)
  VALUES ('0930c000-0000-4000-8000-000000000101', v_acc, '0930c000-0000-4000-8000-000000000301',
          'PEN', 1500, 0, 3, 500, NULL, v_today + 5, 'activo');

  INSERT INTO public.installments (id, plan_id, account_id, number, amount, due_date) VALUES
    ('0930c000-0000-4000-8000-000000000201', '0930c000-0000-4000-8000-000000000101', v_acc, 1, 500, v_today + 5),
    ('0930c000-0000-4000-8000-000000000202', '0930c000-0000-4000-8000-000000000101', v_acc, 2, 500, v_today + 35),
    ('0930c000-0000-4000-8000-000000000203', '0930c000-0000-4000-8000-000000000101', v_acc, 3, 500, v_today + 65);

  PERFORM set_config('t093.acc', v_acc::text, true);
  PERFORM set_config('t093.acc2', v_acc2::text, true);
END $$;

-- ------------------------------------------------------------
-- 1. Los objetos nuevos existen
-- ------------------------------------------------------------
DO $$
DECLARE
  f text;
BEGIN
  IF to_regclass('public.bank_statement_imports') IS NULL OR to_regclass('public.bank_statement_movements') IS NULL THEN
    RAISE EXCEPTION 'FALLO objetos: faltan las tablas del estado de cuenta';
  END IF;
  FOREACH f IN ARRAY ARRAY[
    'public.bank_statement_access(uuid)', 'public.import_bank_statement(jsonb)',
    'public.set_movement_match(uuid,text,uuid,text)', 'public.set_movement_matches(jsonb)'
  ] LOOP
    IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'FALLO objetos: falta la función %', f; END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 2. Administración importa; reimportar no duplica
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0930c000-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"0930c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_payload jsonb;
  v_res     jsonb;
  v_n       int;
BEGIN
  v_payload := jsonb_build_object(
    'banco', 'caja_ica', 'cuenta', '108532321000067245', 'archivo', 'Estado de Cuenta - prueba.xls',
    'periodo_desde', '2026-10-01', 'periodo_hasta', '2026-10-31',
    'filas', jsonb_build_array(
      jsonb_build_object('fecha_hora', '2026-10-01T23:30:00-05:00', 'descripcion', 'TRANS. INTER. INME. (CCE)', 'tipo', 'interbancaria',
        'propio', false, 'deposito', 500, 'retiro', 0, 'saldo', 10500, 'agencia', 'Libertad', 'huella', 'h1', 'estado', 'por_conciliar'),
      jsonb_build_object('fecha_hora', '2026-10-02T09:10:09-05:00', 'descripcion', 'Depósito conv. cobranza', 'tipo', 'convenio',
        'propio', false, 'deposito', 500, 'retiro', 0, 'saldo', 11000, 'agencia', 'Parcona', 'huella', 'h2', 'estado', 'por_conciliar'),
      jsonb_build_object('fecha_hora', '2026-10-02T09:10:09-05:00', 'descripcion', 'Cargo conv. cobranza', 'tipo', 'comision',
        'propio', false, 'deposito', 0, 'retiro', 1.5, 'saldo', 10998.5, 'agencia', 'Parcona', 'huella', 'h3', 'estado', 'no_es_cuota')
    ));
  v_res := public.import_bank_statement(v_payload);
  IF (v_res ->> 'nuevos')::int <> 3 OR (v_res ->> 'duplicados')::int <> 0 THEN
    RAISE EXCEPTION 'FALLO importación: esperaba 3 nuevos y 0 duplicados, dio %', v_res;
  END IF;

  v_res := public.import_bank_statement(v_payload);
  IF (v_res ->> 'nuevos')::int <> 0 OR (v_res ->> 'duplicados')::int <> 3 THEN
    RAISE EXCEPTION 'FALLO reimportación: esperaba 0 nuevos y 3 duplicados, dio %', v_res;
  END IF;

  SELECT count(*) INTO v_n FROM public.bank_statement_movements;
  IF v_n <> 3 THEN RAISE EXCEPTION 'FALLO duplicados: hay % movimientos (esperado 3)', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.bank_statement_imports;
  IF v_n <> 2 THEN RAISE EXCEPTION 'FALLO historial: hay % importaciones (esperado 2)', v_n; END IF;

  -- El día se toma en Lima: 23:30 del 1 de octubre en Lima es 2 de octubre en UTC.
  IF (SELECT fecha FROM public.bank_statement_movements WHERE huella = 'h1') <> DATE '2026-10-01' THEN
    RAISE EXCEPTION 'FALLO fecha: el día debe ser el de Lima';
  END IF;
  IF (SELECT sum(total_depositos) FROM public.bank_statement_imports) <> 2000 THEN
    RAISE EXCEPTION 'FALLO total: el total de depósitos de las importaciones no cuadra';
  END IF;
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- 3. Quién ve el estado de cuenta (suplantando a cada usuario)
-- ------------------------------------------------------------
DO $$
DECLARE
  u record;
  v_n int;
  v_i int;
BEGIN
  FOR u IN SELECT * FROM (VALUES
      ('0930c000-0000-4000-8000-000000000001', 'dueño', 3),
      ('0930c000-0000-4000-8000-000000000002', 'administración', 3),
      ('0930c000-0000-4000-8000-000000000003', 'contabilidad', 3),
      ('0930c000-0000-4000-8000-000000000004', 'gerencia', 3),
      ('0930c000-0000-4000-8000-000000000005', 'cobranzas', 0),
      ('0930c000-0000-4000-8000-000000000006', 'legal', 0),
      ('0930c000-0000-4000-8000-000000000007', 'ventas', 0),
      ('0930c000-0000-4000-8000-000000000008', 'promueve', 0),
      ('0930c000-0000-4000-8000-000000000009', 'sin área', 0),
      ('0930c000-0000-4000-8000-00000000000a', 'otra cuenta', 0)) AS x(id, nombre, esperado)
  LOOP
    PERFORM set_config('request.jwt.claim.sub', u.id, true);
    PERFORM set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', u.id), true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.bank_statement_movements;
    SELECT count(*) INTO v_i FROM public.bank_statement_imports;
    RESET ROLE;
    IF v_n <> u.esperado OR (v_i > 0) <> (u.esperado > 0) THEN
      RAISE EXCEPTION 'FALLO lectura: % ve % movimientos y % importaciones (esperado %)', u.nombre, v_n, v_i, u.esperado;
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 4. Quien no tiene acceso no puede importar ni conciliar
-- ------------------------------------------------------------
DO $$
DECLARE
  u record;
  v_msg text;
  v_mov uuid;
BEGIN
  SELECT id INTO v_mov FROM public.bank_statement_movements WHERE huella = 'h1';
  FOR u IN SELECT * FROM (VALUES
      ('0930c000-0000-4000-8000-000000000005', 'cobranzas'),
      ('0930c000-0000-4000-8000-000000000006', 'legal'),
      ('0930c000-0000-4000-8000-000000000007', 'ventas'),
      ('0930c000-0000-4000-8000-000000000008', 'promueve'),
      ('0930c000-0000-4000-8000-000000000009', 'sin área')) AS x(id, nombre)
  LOOP
    PERFORM set_config('request.jwt.claim.sub', u.id, true);
    PERFORM set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', u.id), true);
    SET LOCAL ROLE authenticated;
    v_msg := NULL;
    BEGIN
      PERFORM public.import_bank_statement(jsonb_build_object('filas', jsonb_build_array(
        jsonb_build_object('fecha_hora', '2026-10-03T10:00:00-05:00', 'descripcion', 'x', 'tipo', 'otro', 'deposito', 1, 'huella', 'x-' || u.nombre))));
    EXCEPTION WHEN insufficient_privilege THEN v_msg := 'denegado'; END;
    IF v_msg IS NULL THEN
      RESET ROLE;
      RAISE EXCEPTION 'FALLO importación: % no debía poder importar', u.nombre;
    END IF;
    v_msg := NULL;
    BEGIN
      PERFORM public.set_movement_match(v_mov, 'revisar', NULL, NULL);
    EXCEPTION WHEN insufficient_privilege THEN v_msg := 'denegado'; END;
    IF v_msg IS NULL THEN
      RESET ROLE;
      RAISE EXCEPTION 'FALLO conciliación: % no debía poder cambiar un movimiento', u.nombre;
    END IF;
    RESET ROLE;
  END LOOP;
  -- Sin sesión.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  SET LOCAL ROLE authenticated;
  v_msg := NULL;
  BEGIN
    PERFORM public.import_bank_statement('{"filas":[]}'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN v_msg := 'denegado'; END;
  RESET ROLE;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO importación: sin sesión no debía poder importar'; END IF;
END $$;

-- ------------------------------------------------------------
-- 5. Los usuarios no escriben las tablas directo
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0930c000-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"0930c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_msg text;
BEGIN
  v_msg := NULL;
  BEGIN
    INSERT INTO public.bank_statement_movements (account_id, fecha_hora, fecha, descripcion, tipo, huella)
    VALUES (current_setting('t093.acc')::uuid, now(), current_date, 'directo', 'otro', 'directo');
  EXCEPTION WHEN insufficient_privilege THEN v_msg := 'ok'; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO escritura directa: INSERT debía negarse'; END IF;
  v_msg := NULL;
  BEGIN
    UPDATE public.bank_statement_movements SET estado = 'revisar';
  EXCEPTION WHEN insufficient_privilege THEN v_msg := 'ok'; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO escritura directa: UPDATE debía negarse'; END IF;
  v_msg := NULL;
  BEGIN
    DELETE FROM public.bank_statement_movements;
  EXCEPTION WHEN insufficient_privilege THEN v_msg := 'ok'; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO escritura directa: DELETE debía negarse'; END IF;
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- 6. Validaciones de la importación
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0930c000-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"0930c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_msg text;
  v_fila jsonb := jsonb_build_object('fecha_hora', '2026-10-03T10:00:00-05:00', 'descripcion', 'x', 'tipo', 'otro', 'deposito', 1, 'huella', 'v-1');
BEGIN
  v_msg := NULL;
  BEGIN PERFORM public.import_bank_statement(jsonb_build_object('filas', jsonb_build_array(v_fila || '{"tipo":"inventado"}'::jsonb)));
  EXCEPTION WHEN check_violation THEN v_msg := 'ok'; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO tipo: un tipo inventado debía rechazarse'; END IF;

  v_msg := NULL;
  BEGIN PERFORM public.import_bank_statement(jsonb_build_object('filas', jsonb_build_array(v_fila || '{"estado":"conciliado"}'::jsonb)));
  EXCEPTION WHEN invalid_parameter_value THEN v_msg := 'ok'; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO estado: no se importa nada ya conciliado'; END IF;

  v_msg := NULL;
  BEGIN PERFORM public.import_bank_statement('{"filas":[]}'::jsonb);
  EXCEPTION WHEN invalid_parameter_value THEN v_msg := 'ok'; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO vacío: un archivo sin movimientos debía rechazarse'; END IF;

  v_msg := NULL;
  BEGIN PERFORM public.import_bank_statement(jsonb_build_object('banco', 'otro_banco', 'filas', jsonb_build_array(v_fila)));
  EXCEPTION WHEN invalid_parameter_value THEN v_msg := 'ok'; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO banco: un banco no soportado debía rechazarse'; END IF;

  -- Lo rechazado no dejó nada.
  IF (SELECT count(*) FROM public.bank_statement_movements) <> 3 THEN
    RAISE EXCEPTION 'FALLO atomicidad: una importación rechazada dejó movimientos';
  END IF;
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- 7. Conciliar con un pago del ERP
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0930c000-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"0930c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_pay1 uuid;
  v_pay2 uuid;
  v_m1   uuid;
  v_m2   uuid;
  v_m3   uuid;
  v_msg  text;
  v_row  public.bank_statement_movements%ROWTYPE;
BEGIN
  SELECT id INTO v_m1 FROM public.bank_statement_movements WHERE huella = 'h1';
  SELECT id INTO v_m2 FROM public.bank_statement_movements WHERE huella = 'h2';
  SELECT id INTO v_m3 FROM public.bank_statement_movements WHERE huella = 'h3';

  v_pay1 := public.register_installment_payment('0930c000-0000-4000-8000-000000000201', 500, NULL, NULL, NULL, NULL);
  v_pay2 := public.register_installment_payment('0930c000-0000-4000-8000-000000000202', 500, NULL, NULL, NULL, NULL);

  PERFORM public.set_movement_match(v_m1, 'conciliado', v_pay1, 'cuota 1');
  SELECT * INTO v_row FROM public.bank_statement_movements WHERE id = v_m1;
  IF v_row.estado <> 'conciliado' OR v_row.payment_id IS DISTINCT FROM v_pay1 OR v_row.conciliado_por IS NULL OR v_row.nota <> 'cuota 1' THEN
    RAISE EXCEPTION 'FALLO conciliar: el movimiento no quedó enlazado al pago';
  END IF;

  -- Un pago respalda a un solo movimiento.
  v_msg := NULL;
  BEGIN PERFORM public.set_movement_match(v_m2, 'conciliado', v_pay1, NULL);
  EXCEPTION WHEN unique_violation THEN v_msg := 'ok'; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO uno a uno: el mismo pago no puede respaldar dos movimientos'; END IF;

  -- Conciliado pide pago; un estado distinto no lo lleva; el estado debe existir; una comisión no se concilia.
  v_msg := NULL;
  BEGIN PERFORM public.set_movement_match(v_m2, 'conciliado', NULL, NULL);
  EXCEPTION WHEN invalid_parameter_value THEN v_msg := 'ok'; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO conciliar: sin pago debía rechazarse'; END IF;
  v_msg := NULL;
  BEGIN PERFORM public.set_movement_match(v_m2, 'revisar', v_pay2, NULL);
  EXCEPTION WHEN invalid_parameter_value THEN v_msg := 'ok'; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO conciliar: otro estado con pago debía rechazarse'; END IF;
  v_msg := NULL;
  BEGIN PERFORM public.set_movement_match(v_m2, 'inventado', NULL, NULL);
  EXCEPTION WHEN invalid_parameter_value THEN v_msg := 'ok'; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO estado: uno inventado debía rechazarse'; END IF;
  v_msg := NULL;
  BEGIN PERFORM public.set_movement_match(v_m3, 'conciliado', v_pay2, NULL);
  EXCEPTION WHEN invalid_parameter_value THEN v_msg := 'ok'; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO conciliar: una comisión (sin depósito) no se concilia'; END IF;

  -- Un pago que no existe.
  v_msg := NULL;
  BEGIN PERFORM public.set_movement_match(v_m2, 'conciliado', '0930c000-0000-4000-8000-0000000009ff', NULL);
  EXCEPTION WHEN invalid_parameter_value THEN v_msg := 'ok'; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO conciliar: un pago inexistente debía rechazarse'; END IF;

  -- Lote: todo o nada.
  IF public.set_movement_matches(jsonb_build_array(
       jsonb_build_object('movement_id', v_m2, 'estado', 'conciliado', 'payment_id', v_pay2),
       jsonb_build_object('movement_id', v_m3, 'estado', 'no_es_cuota'))) <> 2 THEN
    RAISE EXCEPTION 'FALLO lote: debía cambiar 2 movimientos';
  END IF;
  SELECT * INTO v_row FROM public.bank_statement_movements WHERE id = v_m2;
  IF v_row.estado <> 'conciliado' OR v_row.payment_id IS DISTINCT FROM v_pay2 THEN
    RAISE EXCEPTION 'FALLO lote: el segundo depósito no quedó conciliado';
  END IF;

  v_msg := NULL;
  BEGIN
    PERFORM public.set_movement_matches(jsonb_build_array(
      jsonb_build_object('movement_id', v_m1, 'estado', 'revisar'),
      jsonb_build_object('movement_id', v_m3, 'estado', 'inventado')));
  EXCEPTION WHEN invalid_parameter_value THEN v_msg := 'ok'; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO lote: un elemento malo debía frenar el lote'; END IF;
  -- La transacción del DO entero sigue viva: el primer elemento no debe haber quedado aplicado
  -- (el bloque BEGIN..EXCEPTION de plpgsql deshace lo hecho dentro de él).
  SELECT * INTO v_row FROM public.bank_statement_movements WHERE id = v_m1;
  IF v_row.estado <> 'conciliado' THEN RAISE EXCEPTION 'FALLO lote: se aplicó parte de un lote rechazado'; END IF;

  -- Soltar el enlace: cualquier otro estado quita el pago y el pago queda libre.
  PERFORM public.set_movement_match(v_m1, 'por_conciliar', NULL, NULL);
  SELECT * INTO v_row FROM public.bank_statement_movements WHERE id = v_m1;
  IF v_row.estado <> 'por_conciliar' OR v_row.payment_id IS NOT NULL OR v_row.conciliado_por IS NOT NULL THEN
    RAISE EXCEPTION 'FALLO soltar: el movimiento debía quedar sin pago';
  END IF;
  PERFORM public.set_movement_match(v_m3, 'revisar', NULL, 'mirar');
  PERFORM public.set_movement_match(v_m1, 'conciliado', v_pay1, NULL);  -- el pago liberado se puede volver a usar
END $$;
RESET ROLE;

-- Un pago anulado no concilia (el dueño anula; luego administración intenta).
SELECT set_config('request.jwt.claim.sub', '0930c000-0000-4000-8000-000000000001', true),
       set_config('request.jwt.claims', '{"sub":"0930c000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_pay3 uuid;
  v_m2   uuid;
BEGIN
  v_pay3 := public.register_installment_payment('0930c000-0000-4000-8000-000000000203', 500, NULL, NULL, NULL, NULL);
  PERFORM public.void_installment_payment(v_pay3, 'prueba 093');
  PERFORM set_config('t093.pay3', v_pay3::text, true);
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '0930c000-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"0930c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_msg text;
  v_m3  uuid;
BEGIN
  -- h2 está conciliado con otro pago: primero se suelta.
  PERFORM public.set_movement_match((SELECT id FROM public.bank_statement_movements WHERE huella = 'h2'), 'por_conciliar', NULL, NULL);
  v_msg := NULL;
  BEGIN
    PERFORM public.set_movement_match((SELECT id FROM public.bank_statement_movements WHERE huella = 'h2'), 'conciliado', current_setting('t093.pay3')::uuid, NULL);
  EXCEPTION WHEN invalid_parameter_value THEN v_msg := 'ok'; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO anulado: un pago anulado no debía conciliarse'; END IF;
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- 8. Otra cuenta: lo suyo va a su cuenta y no toca lo de la primera
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0930c000-0000-4000-8000-00000000000a', true),
       set_config('request.jwt.claims', '{"sub":"0930c000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_res jsonb;
  v_n   int;
  v_mov uuid;
  v_msg text;
BEGIN
  v_res := public.import_bank_statement(jsonb_build_object('filas', jsonb_build_array(
    jsonb_build_object('fecha_hora', '2026-10-01T10:00:00-05:00', 'descripcion', 'Depósito efectivo', 'tipo', 'efectivo', 'deposito', 77, 'huella', 'h1'))));
  -- Misma huella que en la otra cuenta: son cuentas distintas, entra.
  IF (v_res ->> 'nuevos')::int <> 1 THEN RAISE EXCEPTION 'FALLO cuentas: la huella es por cuenta, debía entrar'; END IF;
  SELECT count(*) INTO v_n FROM public.bank_statement_movements;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLO cuentas: la otra cuenta ve % movimientos (esperado 1, el suyo)', v_n; END IF;
END $$;
RESET ROLE;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.bank_statement_movements WHERE account_id = current_setting('t093.acc')::uuid) <> 3 THEN
    RAISE EXCEPTION 'FALLO cuentas: la primera cuenta cambió';
  END IF;
END $$;

SELECT '093: todos los casos OK' AS resultado;
ROLLBACK;
