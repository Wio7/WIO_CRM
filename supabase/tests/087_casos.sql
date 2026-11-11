-- ============================================================
-- 087_casos.sql — Casos de la migración 087 (Caja: proyecto y rubro)
--
-- Cómo correrlo: DESPUÉS de aplicar 087, pegar todo en el SQL Editor de
-- Supabase (corre como postgres). Cada caso es un DO que lanza
-- RAISE EXCEPTION 'FALLO ...' si algo no cuadra; si llega al final sin
-- error, imprime "087: todos los casos OK". Todo va dentro de una
-- transacción que termina en ROLLBACK: no deja datos.
--
-- Suplantación como en 086_casos.sql (set_config + SET LOCAL ROLE
-- authenticated; RESET ROLE vuelve a postgres). Prefijo de ids 0870c000-.
-- GUC: t087.acc, t087.c1, t087.c2, t087.p1, t087.p2, t087.pout, t087.e1,
--      t087.e3, t087.e4, t087.e5.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- Fixtures (como postgres)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_owner  uuid := '0870c000-0000-4000-8000-000000000001';
  v_cajero uuid := '0870c000-0000-4000-8000-000000000002';  -- encargado de la caja 1
  v_conta  uuid := '0870c000-0000-4000-8000-000000000003';  -- área contabilidad
  v_ger    uuid := '0870c000-0000-4000-8000-000000000004';  -- área gerencia
  v_mkt    uuid := '0870c000-0000-4000-8000-000000000005';  -- marketing, sin caja
  v_otro   uuid := '0870c000-0000-4000-8000-000000000010';  -- dueño de otra cuenta
  v_acc    uuid;
  v_otra   uuid;
  r        record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (v_owner, 't087-owner@example.test'), (v_cajero, 't087-cajero@example.test'),
      (v_conta, 't087-conta@example.test'), (v_ger, 't087-ger@example.test'),
      (v_mkt, 't087-mkt@example.test'), (v_otro, 't087-otro@example.test')
    ) AS u(id, email)
  LOOP
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES (r.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            r.email, jsonb_build_object('full_name', r.email), now(), now());
  END LOOP;

  SELECT account_id INTO v_acc FROM public.profiles WHERE user_id = v_owner;
  IF v_acc IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Prueba 087', v_owner) RETURNING id INTO v_acc;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_owner, 'Dueño 087', 't087-owner@example.test', v_acc, 'owner');
  END IF;
  UPDATE public.accounts SET status = 'active' WHERE id = v_acc;

  FOR r IN
    SELECT * FROM (VALUES
      (v_cajero, 'agent'::account_role_enum, 'ventas',       'Cajero 087'),
      (v_conta,  'agent'::account_role_enum, 'contabilidad', 'Conta 087'),
      (v_ger,    'agent'::account_role_enum, 'gerencia',     'Gerencia 087'),
      (v_mkt,    'agent'::account_role_enum, 'marketing',    'Marketing 087')
    ) AS m(id, role, area, full_name)
  LOOP
    UPDATE public.profiles SET account_id = v_acc, account_role = r.role, area = r.area, full_name = r.full_name
     WHERE user_id = r.id;
    IF NOT FOUND THEN
      INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, area)
      VALUES (r.id, r.full_name, r.id::text || '@example.test', v_acc, r.role, r.area);
    END IF;
  END LOOP;
  UPDATE public.profiles SET full_name = 'Dueño 087' WHERE user_id = v_owner;

  SELECT account_id INTO v_otra FROM public.profiles WHERE user_id = v_otro;
  IF v_otra IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Otra 087', v_otro) RETURNING id INTO v_otra;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_otro, 'Otro 087', 't087-otro@example.test', v_otra, 'owner');
  END IF;

  -- Con 069 en adelante el dueño de la cuenta también debe ser dueño de caja.
  IF to_regclass('public.cash_owners') IS NOT NULL THEN
    EXECUTE 'INSERT INTO public.cash_owners(account_id, user_id, granted_by) VALUES ($1, $2, $2) ON CONFLICT DO NOTHING'
      USING v_acc, v_owner;
    EXECUTE 'INSERT INTO public.cash_owners(account_id, user_id, granted_by) VALUES ($1, $2, $2) ON CONFLICT DO NOTHING'
      USING v_otra, v_otro;
  END IF;

  INSERT INTO public.real_estate_projects (id, account_id, name) VALUES
    ('0870c000-0000-4000-8000-000000000101', v_acc, 'Proyecto Uno 087'),
    ('0870c000-0000-4000-8000-000000000102', v_acc, 'Proyecto Dos 087'),
    ('0870c000-0000-4000-8000-000000000199', v_otra, 'Proyecto Ajeno 087');

  PERFORM set_config('t087.acc', v_acc::text, true);
  PERFORM set_config('t087.p1', '0870c000-0000-4000-8000-000000000101', true);
  PERFORM set_config('t087.p2', '0870c000-0000-4000-8000-000000000102', true);
  PERFORM set_config('t087.pout', '0870c000-0000-4000-8000-000000000199', true);
  PERFORM set_config('t087.c1', '0870c000-0000-4000-8000-0000000000c1', true);
  PERFORM set_config('t087.c2', '0870c000-0000-4000-8000-0000000000c2', true);
END $$;

-- ------------------------------------------------------------
-- El dueño crea dos cajas y da acceso de encargado al cajero en la 1
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0870c000-0000-4000-8000-000000000001', true),
       set_config('request.jwt.claims', '{"sub":"0870c000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.cash_company_command(jsonb_build_object('action', 'company',
    'requestId', current_setting('t087.c1'), 'name', 'Caja 087 A'));
  PERFORM public.cash_company_command(jsonb_build_object('action', 'company',
    'requestId', current_setting('t087.c2'), 'name', 'Caja 087 B'));
  PERFORM public.cash_company_command(jsonb_build_object('action', 'member',
    'companyId', current_setting('t087.c1'), 'userId', '0870c000-0000-4000-8000-000000000002', 'role', 'cashier'));
END $$;
RESET ROLE;

-- Una caja nueva queda con responsable: quien la crea.
DO $$
BEGIN
  IF (SELECT responsible_user_id FROM public.cash_companies WHERE id = current_setting('t087.c1')::uuid)
       IS DISTINCT FROM '0870c000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'FALLO responsable: la caja nueva debía quedar a cargo de quien la creó';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_companies WHERE responsible_user_id IS NULL
               AND account_id = current_setting('t087.acc')::uuid) THEN
    RAISE EXCEPTION 'FALLO responsable: ninguna caja de la cuenta debía quedar sin responsable';
  END IF;
END $$;

-- ------------------------------------------------------------
-- Gastos desde la app (cash_company_entry)
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0870c000-0000-4000-8000-000000000001', true),
       set_config('request.jwt.claims', '{"sub":"0870c000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Lima')::date;
  c1 uuid := current_setting('t087.c1')::uuid;
  c2 uuid := current_setting('t087.c2')::uuid;
  v_id uuid;
  v_id2 uuid;
  v_req uuid;
  v_msg text;
  e public.cash_entries%ROWTYPE;
BEGIN
  -- Con proyecto y rubro.
  v_id := public.cash_company_entry(jsonb_build_object('action', 'entry', 'companyId', c1,
    'requestId', gen_random_uuid(), 'kind', 'expense', 'amountCents', 10000, 'concept', 'Cemento',
    'counterparty', 'Ferretería', 'date', v_today, 'projectId', current_setting('t087.p1'), 'rubro', 'obra'));
  PERFORM set_config('t087.e1', v_id::text, true);
  SELECT * INTO e FROM public.cash_entries WHERE id = v_id;
  IF e.project_id IS DISTINCT FROM current_setting('t087.p1')::uuid OR e.rubro IS DISTINCT FROM 'obra' OR e.project_general THEN
    RAISE EXCEPTION 'FALLO entrada: proyecto/rubro no quedaron (% / % / %)', e.project_id, e.rubro, e.project_general;
  END IF;

  -- Gasto general.
  PERFORM public.cash_company_entry(jsonb_build_object('action', 'entry', 'companyId', c1,
    'requestId', gen_random_uuid(), 'kind', 'expense', 'amountCents', 2000, 'concept', 'Gasolina combi',
    'counterparty', 'Grifo', 'date', v_today, 'projectGeneral', true, 'rubro', 'combi'));
  IF NOT EXISTS (SELECT 1 FROM public.cash_entries WHERE concept = 'Gasolina combi'
                  AND project_general AND project_id IS NULL AND rubro = 'combi') THEN
    RAISE EXCEPTION 'FALLO gasto general: no quedó marcado como general';
  END IF;

  -- Falta el rubro / falta el proyecto: se rechaza en la app.
  v_msg := NULL;
  BEGIN
    PERFORM public.cash_company_entry(jsonb_build_object('action', 'entry', 'companyId', c1,
      'requestId', gen_random_uuid(), 'kind', 'expense', 'amountCents', 100, 'concept', 'Sin rubro',
      'counterparty', 'X', 'date', v_today, 'projectId', current_setting('t087.p1')));
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%rubro%' THEN
    RAISE EXCEPTION 'FALLO sin rubro: debía rechazarse (mensaje: %)', v_msg;
  END IF;
  v_msg := NULL;
  BEGIN
    PERFORM public.cash_company_entry(jsonb_build_object('action', 'entry', 'companyId', c1,
      'requestId', gen_random_uuid(), 'kind', 'expense', 'amountCents', 100, 'concept', 'Sin proyecto',
      'counterparty', 'X', 'date', v_today, 'rubro', 'obra'));
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%proyecto%' THEN
    RAISE EXCEPTION 'FALLO sin proyecto: debía rechazarse (mensaje: %)', v_msg;
  END IF;

  -- Proyecto de otra cuenta, rubro inventado y proyecto + general a la vez.
  v_msg := NULL;
  BEGIN
    PERFORM public.cash_company_entry(jsonb_build_object('action', 'entry', 'companyId', c1,
      'requestId', gen_random_uuid(), 'kind', 'expense', 'amountCents', 100, 'concept', 'Ajeno',
      'counterparty', 'X', 'date', v_today, 'projectId', current_setting('t087.pout'), 'rubro', 'obra'));
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%proyecto no v%' THEN
    RAISE EXCEPTION 'FALLO proyecto ajeno: debía rechazarse (mensaje: %)', v_msg;
  END IF;
  v_msg := NULL;
  BEGIN
    PERFORM public.cash_company_entry(jsonb_build_object('action', 'entry', 'companyId', c1,
      'requestId', gen_random_uuid(), 'kind', 'expense', 'amountCents', 100, 'concept', 'Rubro raro',
      'counterparty', 'X', 'date', v_today, 'projectGeneral', true, 'rubro', 'inventado'));
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%rubro%' THEN
    RAISE EXCEPTION 'FALLO rubro inventado: debía rechazarse (mensaje: %)', v_msg;
  END IF;
  v_msg := NULL;
  BEGIN
    PERFORM public.cash_company_entry(jsonb_build_object('action', 'entry', 'companyId', c1,
      'requestId', gen_random_uuid(), 'kind', 'expense', 'amountCents', 100, 'concept', 'Ambos',
      'counterparty', 'X', 'date', v_today, 'projectGeneral', true, 'projectId', current_setting('t087.p1'), 'rubro', 'obra'));
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'FALLO proyecto y general a la vez: debía rechazarse';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_entries WHERE concept IN ('Sin rubro', 'Sin proyecto', 'Ajeno', 'Rubro raro', 'Ambos')) THEN
    RAISE EXCEPTION 'FALLO rechazos: algún gasto rechazado quedó guardado';
  END IF;

  -- Por WhatsApp (source) no son obligatorios: queda sin asignar.
  v_id := public.cash_company_entry(jsonb_build_object('action', 'entry', 'companyId', c1,
    'requestId', gen_random_uuid(), 'kind', 'expense', 'amountCents', 500, 'concept', 'Taxi',
    'counterparty', 'Chofer', 'date', v_today, 'source', 'whatsapp'));
  PERFORM set_config('t087.e3', v_id::text, true);
  IF NOT EXISTS (SELECT 1 FROM public.cash_entries WHERE id = v_id
                  AND project_id IS NULL AND NOT project_general AND rubro IS NULL) THEN
    RAISE EXCEPTION 'FALLO whatsapp: el gasto debía quedar sin asignar';
  END IF;

  -- Un reintento con el mismo pedido no duplica ni deja ajustes pegados:
  -- el siguiente gasto directo (cash_company_command) no hereda nada.
  v_req := gen_random_uuid();
  v_id := public.cash_company_entry(jsonb_build_object('action', 'entry', 'companyId', c1,
    'requestId', v_req, 'kind', 'expense', 'amountCents', 300, 'concept', 'Reintento',
    'counterparty', 'X', 'date', v_today, 'projectId', current_setting('t087.p2'), 'rubro', 'otros'));
  v_id2 := public.cash_company_entry(jsonb_build_object('action', 'entry', 'companyId', c1,
    'requestId', v_req, 'kind', 'expense', 'amountCents', 300, 'concept', 'Reintento',
    'counterparty', 'X', 'date', v_today, 'projectId', current_setting('t087.p2'), 'rubro', 'otros'));
  IF v_id IS DISTINCT FROM v_id2 OR (SELECT count(*) FROM public.cash_entries WHERE concept = 'Reintento') <> 1 THEN
    RAISE EXCEPTION 'FALLO reintento: debía devolver el mismo movimiento una sola vez';
  END IF;
  PERFORM public.cash_company_command(jsonb_build_object('action', 'entry', 'companyId', c1,
    'requestId', gen_random_uuid(), 'kind', 'expense', 'amountCents', 100, 'concept', 'Directo',
    'counterparty', 'X', 'date', v_today));
  IF NOT EXISTS (SELECT 1 FROM public.cash_entries WHERE concept = 'Directo'
                  AND project_id IS NULL AND rubro IS NULL AND NOT project_general) THEN
    RAISE EXCEPTION 'FALLO ajustes pegados: un gasto posterior heredó proyecto o rubro';
  END IF;

  -- Un ingreso no lleva proyecto ni rubro aunque se envíen.
  PERFORM public.cash_company_entry(jsonb_build_object('action', 'entry', 'companyId', c1,
    'requestId', gen_random_uuid(), 'kind', 'income', 'amountCents', 50000, 'concept', 'Entrega de caja',
    'counterparty', 'Gerente', 'date', v_today, 'projectId', current_setting('t087.p1'), 'rubro', 'obra'));
  IF NOT EXISTS (SELECT 1 FROM public.cash_entries WHERE concept = 'Entrega de caja'
                  AND project_id IS NULL AND rubro IS NULL) THEN
    RAISE EXCEPTION 'FALLO ingreso: no debía llevar proyecto ni rubro';
  END IF;

  -- Un gasto que se anula: la anulación hereda y deja de contar.
  v_id := public.cash_company_entry(jsonb_build_object('action', 'entry', 'companyId', c1,
    'requestId', gen_random_uuid(), 'kind', 'expense', 'amountCents', 3000, 'concept', 'Anulado',
    'counterparty', 'X', 'date', v_today, 'projectId', current_setting('t087.p2'), 'rubro', 'marketing'));
  PERFORM set_config('t087.e4', v_id::text, true);
  PERFORM public.cash_company_command(jsonb_build_object('action', 'reverse', 'companyId', c1,
    'requestId', gen_random_uuid(), 'entryId', v_id, 'reason', 'Se registró dos veces'));
  IF NOT EXISTS (SELECT 1 FROM public.cash_entries WHERE reversal_of = v_id
                  AND project_id = current_setting('t087.p2')::uuid AND rubro = 'marketing') THEN
    RAISE EXCEPTION 'FALLO anulación: debía heredar proyecto y rubro del original';
  END IF;

  -- Segunda caja.
  PERFORM public.cash_company_entry(jsonb_build_object('action', 'entry', 'companyId', c2,
    'requestId', gen_random_uuid(), 'kind', 'expense', 'amountCents', 7000, 'concept', 'Fierro caja B',
    'counterparty', 'Ferretería', 'date', v_today, 'projectId', current_setting('t087.p1'), 'rubro', 'obra'));
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- Panel de gerencia: quién entra y qué suma
--   Vigentes del mes: Cemento 10000 (P1 obra), Gasolina 2000 (general combi),
--   Taxi 500 (sin asignar), Reintento 300 (P2 otros), Directo 100 (sin asignar),
--   Fierro caja B 7000 (P1 obra). El anulado (3000) y su anulación no cuentan.
--   Total 19900 · sin asignar 2 (600) · caja A 12900 · caja B 7000.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_uid text;
  v_panel jsonb;
  v_msg text;
BEGIN
  FOREACH v_uid IN ARRAY ARRAY['0870c000-0000-4000-8000-000000000001', '0870c000-0000-4000-8000-000000000003',
                               '0870c000-0000-4000-8000-000000000004'] LOOP
    PERFORM set_config('request.jwt.claim.sub', v_uid, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_panel := public.cash_management_panel(NULL, NULL);
    RESET ROLE;
    IF (v_panel->>'totalCents')::bigint <> 19900 OR (v_panel->>'count')::int <> 6 THEN
      RAISE EXCEPTION 'FALLO panel total (%): %', v_uid, v_panel;
    END IF;
  END LOOP;

  -- Dueño: desgloses del mes.
  PERFORM set_config('request.jwt.claim.sub', '0870c000-0000-4000-8000-000000000001', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"0870c000-0000-4000-8000-000000000001","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v_panel := public.cash_management_panel(current_date, NULL);
  RESET ROLE;
  IF (v_panel->>'totalCents')::bigint <> 19900 THEN RAISE EXCEPTION 'FALLO panel mes: %', v_panel; END IF;
  IF (v_panel->'unassigned'->>'count')::int <> 2 OR (v_panel->'unassigned'->>'cents')::bigint <> 600 THEN
    RAISE EXCEPTION 'FALLO panel sin asignar: %', v_panel->'unassigned';
  END IF;
  IF (SELECT (x->>'cents')::bigint FROM jsonb_array_elements(v_panel->'byProject') x WHERE x->>'id' = current_setting('t087.p1')) <> 17000
     OR (SELECT (x->>'cents')::bigint FROM jsonb_array_elements(v_panel->'byProject') x WHERE x->>'id' = current_setting('t087.p2')) <> 300
     OR (SELECT (x->>'cents')::bigint FROM jsonb_array_elements(v_panel->'byProject') x WHERE x->>'key' = 'general') <> 2000
     OR (SELECT (x->>'cents')::bigint FROM jsonb_array_elements(v_panel->'byProject') x WHERE x->>'key' = 'sin_asignar') <> 600 THEN
    RAISE EXCEPTION 'FALLO panel por proyecto: %', v_panel->'byProject';
  END IF;
  IF (SELECT (x->>'cents')::bigint FROM jsonb_array_elements(v_panel->'byRubro') x WHERE x->>'rubro' = 'obra') <> 17000
     OR (SELECT (x->>'cents')::bigint FROM jsonb_array_elements(v_panel->'byRubro') x WHERE x->>'rubro' = 'combi') <> 2000
     OR (SELECT (x->>'cents')::bigint FROM jsonb_array_elements(v_panel->'byRubro') x WHERE x->>'rubro' = 'otros') <> 300
     OR (SELECT (x->>'cents')::bigint FROM jsonb_array_elements(v_panel->'byRubro') x WHERE x->>'rubro' = 'sin_asignar') <> 600
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_panel->'byRubro') x WHERE x->>'rubro' = 'marketing') THEN
    RAISE EXCEPTION 'FALLO panel por rubro: %', v_panel->'byRubro';
  END IF;
  IF (SELECT (x->>'cents')::bigint FROM jsonb_array_elements(v_panel->'byCompany') x WHERE x->>'id' = current_setting('t087.c1')) <> 12900
     OR (SELECT (x->>'cents')::bigint FROM jsonb_array_elements(v_panel->'byCompany') x WHERE x->>'id' = current_setting('t087.c2')) <> 7000
     OR (SELECT x->>'responsible' FROM jsonb_array_elements(v_panel->'byCompany') x WHERE x->>'id' = current_setting('t087.c1')) <> 'Dueño 087' THEN
    RAISE EXCEPTION 'FALLO panel por caja: %', v_panel->'byCompany';
  END IF;
  IF jsonb_array_length(v_panel->'byMonth') <> 12
     OR (v_panel->'byMonth'->11->>'cents')::bigint <> 19900
     OR (v_panel->'byMonth'->>0) IS NULL THEN
    RAISE EXCEPTION 'FALLO panel por mes: %', v_panel->'byMonth';
  END IF;
  IF jsonb_array_length(v_panel->'projects') <> 2 THEN RAISE EXCEPTION 'FALLO panel proyectos: %', v_panel->'projects'; END IF;
  IF jsonb_array_length(v_panel->'pending') <> 2 THEN RAISE EXCEPTION 'FALLO panel pendientes: %', v_panel->'pending'; END IF;

  -- Filtro por caja y por otro mes.
  SET LOCAL ROLE authenticated;
  v_panel := public.cash_management_panel(current_date, current_setting('t087.c2')::uuid);
  RESET ROLE;
  IF (v_panel->>'totalCents')::bigint <> 7000 THEN RAISE EXCEPTION 'FALLO panel filtro caja: %', v_panel; END IF;
  SET LOCAL ROLE authenticated;
  v_panel := public.cash_management_panel((current_date - interval '2 months')::date, NULL);
  RESET ROLE;
  IF (v_panel->>'totalCents')::bigint <> 0 THEN RAISE EXCEPTION 'FALLO panel otro mes: %', v_panel; END IF;

  -- Sin acceso: encargado, marketing. Otra cuenta ve lo suyo, no lo nuestro.
  FOREACH v_uid IN ARRAY ARRAY['0870c000-0000-4000-8000-000000000002', '0870c000-0000-4000-8000-000000000005'] LOOP
    PERFORM set_config('request.jwt.claim.sub', v_uid, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_msg := NULL;
    BEGIN
      PERFORM public.cash_management_panel(NULL, NULL);
    EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
    RESET ROLE;
    IF v_msg IS NULL OR v_msg NOT ILIKE '%acceso%' THEN
      RAISE EXCEPTION 'FALLO panel sin acceso (%): debía rechazarse (mensaje: %)', v_uid, v_msg;
    END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', '0870c000-0000-4000-8000-000000000010', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"0870c000-0000-4000-8000-000000000010","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v_panel := public.cash_management_panel(NULL, NULL);
  RESET ROLE;
  IF (v_panel->>'totalCents')::bigint <> 0 OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_panel->'companies') x WHERE x->>'id' IN (current_setting('t087.c1'), current_setting('t087.c2'))) THEN
    RAISE EXCEPTION 'FALLO panel otra cuenta: vio datos de otra cuenta (%)', v_panel;
  END IF;
END $$;

-- ------------------------------------------------------------
-- Opciones del formulario y responsable
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0870c000-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"0870c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE o jsonb; v_msg text;
BEGIN
  o := public.cash_form_options(current_setting('t087.c1')::uuid);
  IF jsonb_array_length(o->'projects') <> 2 OR o->>'canPanel' <> 'false'
     OR o->'responsible'->>'name' <> 'Dueño 087' OR jsonb_array_length(o->'rubros') <> 6 THEN
    RAISE EXCEPTION 'FALLO opciones del encargado: %', o;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(o->'projects') x WHERE x->>'id' = current_setting('t087.pout')) THEN
    RAISE EXCEPTION 'FALLO opciones: aparece un proyecto de otra cuenta';
  END IF;
  -- Sin acceso a la caja B.
  v_msg := NULL;
  BEGIN PERFORM public.cash_form_options(current_setting('t087.c2')::uuid);
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO opciones: el encargado no debía ver la caja B'; END IF;
  -- Solo el dueño cambia al responsable.
  v_msg := NULL;
  BEGIN PERFORM public.cash_set_responsible(current_setting('t087.c1')::uuid, '0870c000-0000-4000-8000-000000000002');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO responsable: el encargado no debía poder cambiarlo'; END IF;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', '0870c000-0000-4000-8000-000000000001', true),
       set_config('request.jwt.claims', '{"sub":"0870c000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE o jsonb; v_msg text;
BEGIN
  PERFORM public.cash_set_responsible(current_setting('t087.c1')::uuid, '0870c000-0000-4000-8000-000000000002');
  o := public.cash_form_options(current_setting('t087.c1')::uuid);
  IF o->'responsible'->>'name' <> 'Cajero 087' OR o->>'canSetResponsible' <> 'true' OR o->>'canPanel' <> 'true' THEN
    RAISE EXCEPTION 'FALLO responsable: %', o;
  END IF;
  v_msg := NULL;
  BEGIN PERFORM public.cash_set_responsible(current_setting('t087.c1')::uuid, '0870c000-0000-4000-8000-000000000010');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO responsable: una persona de otra cuenta no debía aceptarse'; END IF;
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- Completar la clasificación (cash_classify_entry)
-- ------------------------------------------------------------
-- El encargado registra un gasto por su cuenta y lo completa; no toca el del dueño.
SELECT set_config('request.jwt.claim.sub', '0870c000-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"0870c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Lima')::date;
  v_id uuid; v_msg text;
BEGIN
  v_id := public.cash_company_entry(jsonb_build_object('action', 'entry', 'companyId', current_setting('t087.c1'),
    'requestId', gen_random_uuid(), 'kind', 'expense', 'amountCents', 400, 'concept', 'Pasaje',
    'counterparty', 'X', 'date', v_today, 'source', 'whatsapp'));
  PERFORM set_config('t087.e5', v_id::text, true);
  PERFORM public.cash_classify_entry(v_id, current_setting('t087.p2')::uuid, false, 'personal');
  IF NOT EXISTS (SELECT 1 FROM public.cash_entries WHERE id = v_id
                  AND project_id = current_setting('t087.p2')::uuid AND rubro = 'personal') THEN
    RAISE EXCEPTION 'FALLO clasificar propio: no quedó guardado';
  END IF;
  v_msg := NULL;
  BEGIN PERFORM public.cash_classify_entry(current_setting('t087.e3')::uuid, current_setting('t087.p1')::uuid, false, 'combi');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%permiso%' THEN
    RAISE EXCEPTION 'FALLO clasificar ajeno: el encargado no debía poder (mensaje: %)', v_msg;
  END IF;
END $$;
RESET ROLE;

-- Marketing no puede; contabilidad sí.
SELECT set_config('request.jwt.claim.sub', '0870c000-0000-4000-8000-000000000005', true),
       set_config('request.jwt.claims', '{"sub":"0870c000-0000-4000-8000-000000000005","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_msg text;
BEGIN
  BEGIN PERFORM public.cash_classify_entry(current_setting('t087.e3')::uuid, NULL, true, 'combi');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO clasificar marketing: no debía poder'; END IF;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', '0870c000-0000-4000-8000-000000000003', true),
       set_config('request.jwt.claims', '{"sub":"0870c000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_msg text;
BEGIN
  PERFORM public.cash_classify_entry(current_setting('t087.e3')::uuid, NULL, true, 'combi');
  -- Datos incompletos o inválidos.
  v_msg := NULL;
  BEGIN PERFORM public.cash_classify_entry(current_setting('t087.e3')::uuid, NULL, false, 'combi');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO clasificar: sin proyecto ni general debía rechazarse'; END IF;
  v_msg := NULL;
  BEGIN PERFORM public.cash_classify_entry(current_setting('t087.e3')::uuid, current_setting('t087.pout')::uuid, false, 'obra');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO clasificar: proyecto ajeno debía rechazarse'; END IF;
  v_msg := NULL;
  BEGIN PERFORM public.cash_classify_entry(current_setting('t087.e4')::uuid, NULL, true, 'obra');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL THEN RAISE EXCEPTION 'FALLO clasificar: un gasto anulado debía rechazarse'; END IF;
END $$;
RESET ROLE;

-- Lo clasificado queda guardado y en el historial de la caja.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.cash_entries WHERE id = current_setting('t087.e3')::uuid
                  AND project_general AND project_id IS NULL AND rubro = 'combi') THEN
    RAISE EXCEPTION 'FALLO clasificar contabilidad: no quedó guardado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cash_entry_audit WHERE entry_id = current_setting('t087.e3')::uuid
                  AND action = 'edited' AND (after_data->>'rubro') = 'combi') THEN
    RAISE EXCEPTION 'FALLO historial: la clasificación debía quedar registrada';
  END IF;
END $$;

-- ------------------------------------------------------------
-- WhatsApp: cash_as_user pasa proyecto y rubro del borrador
-- (solo si esta base tiene cash_is_owner y cash_as_user, es decir 075)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Lima')::date;
  v_id uuid;
BEGIN
  IF to_regprocedure('public.cash_is_owner()') IS NULL OR to_regprocedure('public.cash_as_user(uuid,text,jsonb)') IS NULL THEN
    RAISE NOTICE '087: sin 075 en esta base, se omite el caso de WhatsApp';
    RETURN;
  END IF;
  v_id := (public.cash_as_user('0870c000-0000-4000-8000-000000000001', 'entry', jsonb_build_object(
    'companyId', current_setting('t087.c1'), 'requestId', gen_random_uuid(), 'kind', 'expense', 'amountCents', 900,
    'concept', 'Volantes', 'counterparty', 'Imprenta', 'date', v_today,
    'projectId', current_setting('t087.p1'), 'rubro', 'marketing')) #>> '{}')::uuid;
  IF NOT EXISTS (SELECT 1 FROM public.cash_entries WHERE id = v_id
                  AND project_id = current_setting('t087.p1')::uuid AND rubro = 'marketing') THEN
    RAISE EXCEPTION 'FALLO whatsapp: el borrador con proyecto y rubro no los guardó';
  END IF;
  v_id := (public.cash_as_user('0870c000-0000-4000-8000-000000000001', 'entry', jsonb_build_object(
    'companyId', current_setting('t087.c1'), 'requestId', gen_random_uuid(), 'kind', 'expense', 'amountCents', 800,
    'concept', 'Sin deducir', 'counterparty', 'X', 'date', v_today)) #>> '{}')::uuid;
  IF NOT EXISTS (SELECT 1 FROM public.cash_entries WHERE id = v_id
                  AND project_id IS NULL AND rubro IS NULL AND NOT project_general) THEN
    RAISE EXCEPTION 'FALLO whatsapp: sin proyecto ni rubro debía quedar sin asignar';
  END IF;
END $$;

SELECT '087: todos los casos OK' AS resultado;

ROLLBACK;
