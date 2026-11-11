-- ============================================================
-- 092_casos.sql — Casos de la migración 092 (área Administración)
--
-- Cómo correrlo: DESPUÉS de aplicar 092, pegar todo en el SQL Editor de
-- Supabase (corre como postgres). Cada caso es un DO que lanza
-- RAISE EXCEPTION 'FALLO ...' si algo no cuadra; si llega al final sin
-- error, imprime "092: todos los casos OK". Todo va dentro de una
-- transacción que termina en ROLLBACK: no deja datos.
--
-- Suplantación como en 089_casos.sql (set_config + SET LOCAL ROLE
-- authenticated; RESET ROLE vuelve a postgres). Prefijo de ids 0920c000-.
-- GUC: t092.acc.
--
-- Qué demuestra: Administración puede lo mismo que Contabilidad sobre pagos,
-- planes, cuotas y el panel de la caja, confirma pagos, y NADA más (no legal,
-- no ventas, no gerencia, no abona a capital). Un Promueve sigue sin ver nada.
--
-- Las filas que inserta solo usan columnas que existen en la base real y en
-- las migraciones del repo (validado contra el esquema OpenAPI: accounts,
-- profiles, contacts, payment_plans, installments).
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- Fixtures (como postgres)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_owner uuid := '0920c000-0000-4000-8000-000000000001';
  v_conta uuid := '0920c000-0000-4000-8000-000000000002';  -- contabilidad
  v_admin uuid := '0920c000-0000-4000-8000-000000000003';  -- administracion (agent)
  v_legal uuid := '0920c000-0000-4000-8000-000000000004';  -- legal
  v_mkt   uuid := '0920c000-0000-4000-8000-000000000005';  -- marketing
  v_vent  uuid := '0920c000-0000-4000-8000-000000000006';  -- ventas
  v_pro   uuid := '0920c000-0000-4000-8000-000000000007';  -- Promueve
  v_sin   uuid := '0920c000-0000-4000-8000-000000000008';  -- agente sin área
  v_adm2  uuid := '0920c000-0000-4000-8000-000000000009';  -- rol admin, sin área (asigna áreas)
  v_acc   uuid;
  v_today date := (now() AT TIME ZONE 'America/Lima')::date;
  r       record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (v_owner, 't092-owner@example.test'), (v_conta, 't092-conta@example.test'),
      (v_admin, 't092-admin@example.test'), (v_legal, 't092-legal@example.test'),
      (v_mkt, 't092-mkt@example.test'), (v_vent, 't092-vent@example.test'),
      (v_pro, 't092-pro@example.test'), (v_sin, 't092-sin@example.test'),
      (v_adm2, 't092-adm2@example.test')
    ) AS u(id, email)
  LOOP
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES (r.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            r.email, jsonb_build_object('full_name', r.email), now(), now());
  END LOOP;

  SELECT account_id INTO v_acc FROM public.profiles WHERE user_id = v_owner;
  IF v_acc IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Prueba 092', v_owner) RETURNING id INTO v_acc;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_owner, 'Dueño 092', 't092-owner@example.test', v_acc, 'owner');
  END IF;
  UPDATE public.accounts SET status = 'active' WHERE id = v_acc;
  -- Peor caso: la cuenta deja ver todas las conversaciones a cualquier agente.
  UPDATE public.accounts SET agents_see_only_assigned = false WHERE id = v_acc
    AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'agents_see_only_assigned');

  FOR r IN
    SELECT * FROM (VALUES
      (v_conta, 'agent'::account_role_enum, 'contabilidad', 'Conta 092'),
      (v_admin, 'agent'::account_role_enum, 'administracion', 'Administración 092'),
      (v_legal, 'agent'::account_role_enum, 'legal', 'Legal 092'),
      (v_mkt,   'agent'::account_role_enum, 'marketing', 'Marketing 092'),
      (v_vent,  'agent'::account_role_enum, 'ventas', 'Ventas 092'),
      (v_pro,   'agent'::account_role_enum, 'promueve', 'Externo 092'),
      (v_sin,   'agent'::account_role_enum, NULL::text, 'Sin área 092'),
      (v_adm2,  'admin'::account_role_enum, NULL::text, 'Admin rol 092')
    ) AS m(id, role, area, full_name)
  LOOP
    UPDATE public.profiles SET account_id = v_acc, account_role = r.role, area = r.area, full_name = r.full_name
     WHERE user_id = r.id;
    IF NOT FOUND THEN
      INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, area)
      VALUES (r.id, r.full_name, r.id::text || '@example.test', v_acc, r.role, r.area);
    END IF;
  END LOOP;

  INSERT INTO public.contacts (id, account_id, user_id, phone, name)
  VALUES ('0920c000-0000-4000-8000-000000000301', v_acc, v_owner, '+51900092092', 'Cliente 092');

  INSERT INTO public.payment_plans (id, account_id, contact_id, currency, total_amount, down_payment,
                                    installments_count, monthly_amount, due_day, first_due_date, status)
  VALUES ('0920c000-0000-4000-8000-000000000101', v_acc, '0920c000-0000-4000-8000-000000000301',
          'PEN', 1500, 0, 3, 500, NULL, v_today + 5, 'activo');

  INSERT INTO public.installments (id, plan_id, account_id, number, amount, due_date) VALUES
    ('0920c000-0000-4000-8000-000000000201', '0920c000-0000-4000-8000-000000000101', v_acc, 1, 500, v_today + 5),
    ('0920c000-0000-4000-8000-000000000202', '0920c000-0000-4000-8000-000000000101', v_acc, 2, 500, v_today + 35),
    ('0920c000-0000-4000-8000-000000000203', '0920c000-0000-4000-8000-000000000101', v_acc, 3, 500, v_today + 65);

  PERFORM set_config('t092.acc', v_acc::text, true);
END $$;

-- ------------------------------------------------------------
-- 1. La base acepta el área nueva y rechaza una inventada
-- ------------------------------------------------------------
DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.profiles WHERE area = 'administracion'
     AND user_id = '0920c000-0000-4000-8000-000000000003';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FALLO check: el perfil con area administracion no se guardó';
  END IF;
  BEGIN
    UPDATE public.profiles SET area = 'inventada' WHERE user_id = '0920c000-0000-4000-8000-000000000006';
    RAISE EXCEPTION 'FALLO check: un área inventada debía rechazarse';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

-- ------------------------------------------------------------
-- 2. Matriz de módulos (suplantando a cada usuario por sesión).
--    Administración == Contabilidad en todos los módulos.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_acc uuid := current_setting('t092.acc')::uuid;
  u record;
  m text;
  v_conta boolean;
  v_adm boolean;
BEGIN
  FOREACH m IN ARRAY ARRAY['cobranzas', 'cronograma', 'legal', 'ventas'] LOOP
    PERFORM set_config('request.jwt.claim.sub', '0920c000-0000-4000-8000-000000000002', true);
    v_conta := public.can_access_module(v_acc, m);
    PERFORM set_config('request.jwt.claim.sub', '0920c000-0000-4000-8000-000000000003', true);
    v_adm := public.can_access_module(v_acc, m);
    IF v_conta IS DISTINCT FROM v_adm THEN
      RAISE EXCEPTION 'FALLO módulo %: contabilidad=% pero administración=%', m, v_conta, v_adm;
    END IF;
    IF m IN ('cobranzas', 'cronograma') AND NOT v_adm THEN
      RAISE EXCEPTION 'FALLO módulo %: administración debía entrar', m;
    END IF;
    IF m IN ('legal', 'ventas') AND v_adm THEN
      RAISE EXCEPTION 'FALLO módulo %: administración no debía entrar', m;
    END IF;
  END LOOP;

  -- No es gerencia: no es dueño-o-gerencia y no gestiona el cronograma.
  PERFORM set_config('request.jwt.claim.sub', '0920c000-0000-4000-8000-000000000003', true);
  IF public.is_owner_or_gerencia(v_acc) THEN
    RAISE EXCEPTION 'FALLO gerencia: administración no es gerencia';
  END IF;
  IF public.can_manage_schedule(v_acc) THEN
    RAISE EXCEPTION 'FALLO cronograma: administración no gestiona el cronograma (igual que contabilidad)';
  END IF;

  -- Los demás siguen igual: ni legal, marketing, ventas, Promueve ni sin área entran a cobranzas.
  FOR u IN SELECT * FROM (VALUES
      ('0920c000-0000-4000-8000-000000000004'::uuid, 'legal'),
      ('0920c000-0000-4000-8000-000000000005'::uuid, 'marketing'),
      ('0920c000-0000-4000-8000-000000000006'::uuid, 'ventas'),
      ('0920c000-0000-4000-8000-000000000007'::uuid, 'promueve'),
      ('0920c000-0000-4000-8000-000000000008'::uuid, 'sin área')) AS x(id, nombre)
  LOOP
    PERFORM set_config('request.jwt.claim.sub', u.id::text, true);
    IF public.can_access_module(v_acc, 'cobranzas') THEN
      RAISE EXCEPTION 'FALLO módulo cobranzas: % no debía entrar', u.nombre;
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 3. Administración lee lo que Contabilidad lee, y confirma pagos
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0920c000-0000-4000-8000-000000000003', true),
       set_config('request.jwt.claims', '{"sub":"0920c000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_pay uuid;
  v_n   int;
  v_msg text;
BEGIN
  SELECT count(*) INTO v_n FROM public.payment_plans;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLO lectura: administración ve % planes (esperado 1)', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.installments;
  IF v_n <> 3 THEN RAISE EXCEPTION 'FALLO lectura: administración ve % cuotas (esperado 3)', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.installment_schedule;
  IF v_n <> 3 THEN RAISE EXCEPTION 'FALLO lectura: administración ve % filas del cronograma (esperado 3)', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.installment_balances;
  IF v_n <> 3 THEN RAISE EXCEPTION 'FALLO lectura: administración ve % saldos (esperado 3)', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.contacts;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLO lectura: administración ve % contactos con plan (esperado 1)', v_n; END IF;

  -- Confirma un pago que llegó a la caja.
  v_pay := public.register_installment_payment('0920c000-0000-4000-8000-000000000201', 500, NULL, NULL, NULL, NULL);
  SELECT count(*) INTO v_n FROM public.installment_payments WHERE id = v_pay;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLO pago: administración no ve el pago que registró'; END IF;

  -- Abonar a capital sigue siendo solo del dueño y de gerencia.
  BEGIN
    PERFORM public.apply_prepayment('0920c000-0000-4000-8000-000000000101', 100, 'reducir_cuota',
      '[{"id":"0920c000-0000-4000-8000-000000000203","newAmount":400}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%gerencia%' THEN
    RAISE EXCEPTION 'FALLO abono: administración no debía abonar a capital (mensaje: %)', v_msg;
  END IF;
END $$;
RESET ROLE;

-- Referencia: Contabilidad ve el pago que registró Administración.
SELECT set_config('request.jwt.claim.sub', '0920c000-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"0920c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.installment_payments;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLO referencia: contabilidad ve % pagos (esperado 1)', v_n; END IF;
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- 4. Quien no es de pagos no ve nada: marketing, ventas, sin área, Promueve
-- ------------------------------------------------------------
DO $$
DECLARE
  u record;
  v_n int;
BEGIN
  FOR u IN SELECT * FROM (VALUES
      ('0920c000-0000-4000-8000-000000000005', 'marketing'),
      ('0920c000-0000-4000-8000-000000000006', 'ventas'),
      ('0920c000-0000-4000-8000-000000000007', 'promueve'),
      ('0920c000-0000-4000-8000-000000000008', 'sin área')) AS x(id, nombre)
  LOOP
    PERFORM set_config('request.jwt.claim.sub', u.id, true);
    PERFORM set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', u.id), true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.installment_payments;
    IF v_n <> 0 THEN RAISE EXCEPTION 'FALLO privacidad: % ve % pagos', u.nombre, v_n; END IF;
    SELECT count(*) INTO v_n FROM public.installment_balances;
    IF v_n <> 0 THEN RAISE EXCEPTION 'FALLO privacidad: % ve % saldos', u.nombre, v_n; END IF;
    SELECT count(*) INTO v_n FROM public.installment_schedule;
    IF v_n <> 0 THEN RAISE EXCEPTION 'FALLO privacidad: % ve % filas del cronograma', u.nombre, v_n; END IF;
    RESET ROLE;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 5. Panel de gerencia de la caja chica: administración y contabilidad sí;
--    legal, marketing, ventas, sin área y Promueve no.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_acc uuid := current_setting('t092.acc')::uuid;
  u record;
  v_ok boolean;
BEGIN
  FOR u IN SELECT * FROM (VALUES
      ('0920c000-0000-4000-8000-000000000002'::uuid, 'contabilidad', true),
      ('0920c000-0000-4000-8000-000000000003'::uuid, 'administración', true),
      ('0920c000-0000-4000-8000-000000000004'::uuid, 'legal', false),
      ('0920c000-0000-4000-8000-000000000005'::uuid, 'marketing', false),
      ('0920c000-0000-4000-8000-000000000006'::uuid, 'ventas', false),
      ('0920c000-0000-4000-8000-000000000007'::uuid, 'promueve', false),
      ('0920c000-0000-4000-8000-000000000008'::uuid, 'sin área', false)) AS x(id, nombre, espera)
  LOOP
    PERFORM set_config('request.jwt.claim.sub', u.id::text, true);
    v_ok := public.cash_panel_access(v_acc);
    IF v_ok IS DISTINCT FROM u.espera THEN
      RAISE EXCEPTION 'FALLO panel de caja: % => % (esperado %)', u.nombre, v_ok, u.espera;
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 6. set_member_area: el dueño y el administrador asignan Administración;
--    un área inventada se rechaza; un agente no se la pone solo.
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0920c000-0000-4000-8000-000000000001', true),
       set_config('request.jwt.claims', '{"sub":"0920c000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_area text; v_msg text;
BEGIN
  PERFORM public.set_member_area('0920c000-0000-4000-8000-000000000008', 'administracion');
  SELECT area INTO v_area FROM public.profiles WHERE user_id = '0920c000-0000-4000-8000-000000000008';
  IF v_area IS DISTINCT FROM 'administracion' THEN
    RAISE EXCEPTION 'FALLO set_member_area (dueño): quedó %', v_area;
  END IF;
  BEGIN PERFORM public.set_member_area('0920c000-0000-4000-8000-000000000008', 'inventada');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%Unknown area%' THEN
    RAISE EXCEPTION 'FALLO set_member_area: un área inventada debía rechazarse (mensaje: %)', v_msg;
  END IF;
  -- Las anteriores siguen valiendo.
  PERFORM public.set_member_area('0920c000-0000-4000-8000-000000000008', 'promueve');
  PERFORM public.set_member_area('0920c000-0000-4000-8000-000000000008', 'contabilidad');
  PERFORM public.set_member_area('0920c000-0000-4000-8000-000000000008', NULL);
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', '0920c000-0000-4000-8000-000000000009', true),
       set_config('request.jwt.claims', '{"sub":"0920c000-0000-4000-8000-000000000009","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_area text;
BEGIN
  PERFORM public.set_member_area('0920c000-0000-4000-8000-000000000008', 'administracion');
  SELECT area INTO v_area FROM public.profiles WHERE user_id = '0920c000-0000-4000-8000-000000000008';
  IF v_area IS DISTINCT FROM 'administracion' THEN
    RAISE EXCEPTION 'FALLO set_member_area (rol admin): quedó %', v_area;
  END IF;
END $$;
RESET ROLE;

-- Un agente no se asigna el área por su cuenta (guard de 084).
SELECT set_config('request.jwt.claim.sub', '0920c000-0000-4000-8000-000000000005', true),
       set_config('request.jwt.claims', '{"sub":"0920c000-0000-4000-8000-000000000005","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_msg text;
BEGIN
  BEGIN UPDATE public.profiles SET area = 'administracion' WHERE user_id = '0920c000-0000-4000-8000-000000000005';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'FALLO autoasignación: un agente no debía poder ponerse Administración';
  END IF;
END $$;
RESET ROLE;

SELECT '092: todos los casos OK' AS resultado;
ROLLBACK;
