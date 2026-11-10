-- ============================================================
-- 086_casos.sql — Casos de la migración 086 (Postventa)
--
-- Cómo correrlo: DESPUÉS de aplicar 086, pegar todo en el SQL Editor de
-- Supabase (corre como postgres). Cada caso es un DO que lanza
-- RAISE EXCEPTION 'FALLO ...' si algo no cuadra; si llega al final sin
-- error, imprime "086: todos los casos OK". Todo va dentro de una
-- transacción que termina en ROLLBACK: no deja datos.
--
-- Suplantación como en 085_casos.sql (set_config + SET LOCAL ROLE
-- authenticated; RESET ROLE vuelve a postgres). Prefijo de ids 0860c000-.
-- Fechas: las visitas usan el próximo lunes/sábado según la hora de Lima.
-- GUC: t086.acc, t086.h1, t086.h2, t086.case1, t086.case2, t086.appt1.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- Fixtures (como postgres)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_owner  uuid := '0860c000-0000-4000-8000-000000000001';
  v_cobr   uuid := '0860c000-0000-4000-8000-000000000002';
  v_pv     uuid := '0860c000-0000-4000-8000-000000000003';  -- postventa (módulo explícito)
  v_pv2    uuid := '0860c000-0000-4000-8000-000000000004';  -- segundo con postventa
  v_mkt    uuid := '0860c000-0000-4000-8000-000000000005';  -- sin postventa
  v_ger    uuid := '0860c000-0000-4000-8000-000000000006';  -- área gerencia
  v_otro   uuid := '0860c000-0000-4000-8000-000000000010';  -- dueño de otra cuenta
  v_acc    uuid;
  v_otra   uuid;
  r        record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (v_owner, 't086-owner@example.test'), (v_cobr, 't086-cobr@example.test'),
      (v_pv, 't086-pv@example.test'), (v_pv2, 't086-pv2@example.test'),
      (v_mkt, 't086-mkt@example.test'), (v_ger, 't086-ger@example.test'),
      (v_otro, 't086-otro@example.test')
    ) AS u(id, email)
  LOOP
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES (r.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            r.email, jsonb_build_object('full_name', r.email), now(), now());
  END LOOP;

  SELECT account_id INTO v_acc FROM public.profiles WHERE user_id = v_owner;
  IF v_acc IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Prueba 086', v_owner) RETURNING id INTO v_acc;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_owner, 'Dueño 086', 't086-owner@example.test', v_acc, 'owner');
  END IF;
  UPDATE public.accounts SET status = 'active' WHERE id = v_acc;

  FOR r IN
    SELECT * FROM (VALUES
      (v_cobr, 'agent'::account_role_enum, 'cobranzas', 'Cobranzas 086'),
      (v_pv,   'agent'::account_role_enum, 'ventas',    'Postventa Uno 086'),
      (v_pv2,  'agent'::account_role_enum, 'ventas',    'Postventa Dos 086'),
      (v_mkt,  'agent'::account_role_enum, 'marketing', 'Marketing 086'),
      (v_ger,  'agent'::account_role_enum, 'gerencia',  'Gerencia 086')
    ) AS m(id, role, area, full_name)
  LOOP
    UPDATE public.profiles SET account_id = v_acc, account_role = r.role, area = r.area, full_name = r.full_name
     WHERE user_id = r.id;
    IF NOT FOUND THEN
      INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, area)
      VALUES (r.id, r.full_name, r.id::text || '@example.test', v_acc, r.role, r.area);
    END IF;
  END LOOP;
  UPDATE public.profiles SET full_name = 'Dueño 086' WHERE user_id = v_owner;

  INSERT INTO public.account_module_members (account_id, user_id, module_key)
  VALUES (v_acc, v_pv, 'postventa'), (v_acc, v_pv2, 'postventa');

  INSERT INTO public.contacts (id, account_id, user_id, phone, name) VALUES
    ('0860c000-0000-4000-8000-000000000301', v_acc, v_owner, '+51900086086', 'Cliente 086'),
    ('0860c000-0000-4000-8000-000000000303', v_acc, v_owner, '+51900086087', 'Cliente Dos 086');

  -- Franjas de v_pv: lunes y sábado 9:00-10:00 y 11:00-12:00 (minutos desde medianoche).
  INSERT INTO public.staff_availability (account_id, user_id, weekday, starts_min, ends_min) VALUES
    (v_acc, v_pv, 1, 540, 600), (v_acc, v_pv, 1, 660, 720),
    (v_acc, v_pv, 6, 540, 600), (v_acc, v_pv, 6, 660, 720),
    (v_acc, v_pv, 3, 540, 600);   -- miércoles: existe franja, pero no es día de visita

  SELECT account_id INTO v_otra FROM public.profiles WHERE user_id = v_otro;
  IF v_otra IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Otra 086', v_otro) RETURNING id INTO v_otra;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_otro, 'Otro 086', 't086-otro@example.test', v_otra, 'owner');
  END IF;

  PERFORM set_config('t086.acc', v_acc::text, true);
END $$;

-- ------------------------------------------------------------
-- my_module_access incluye postventa
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0860c000-0000-4000-8000-000000000003', true),
       set_config('request.jwt.claims', '{"sub":"0860c000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF (public.my_module_access()->>'postventa') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'FALLO acceso: postventa debía ser true para quien tiene el módulo (%)', public.my_module_access();
  END IF;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', '0860c000-0000-4000-8000-000000000005', true),
       set_config('request.jwt.claims', '{"sub":"0860c000-0000-4000-8000-000000000005","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF (public.my_module_access()->>'postventa') IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'FALLO acceso: postventa debía ser false sin módulo (%)', public.my_module_access();
  END IF;
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- Cobranzas envía dos casos a postventa
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0860c000-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"0860c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM set_config('t086.h1', public.send_handoff('postventa_desde_cobranzas',
    '0860c000-0000-4000-8000-000000000301', 'Quiere ver su lote', 'entrega')::text, true);
  PERFORM set_config('t086.h2', public.send_handoff('postventa_desde_cobranzas',
    '0860c000-0000-4000-8000-000000000303', 'Duda de documentos', 'documentos')::text, true);
END $$;
RESET ROLE;

-- Todavía no hay casos: un traspaso pendiente no abre caso.
DO $$
BEGIN
  IF (SELECT count(*) FROM public.postventa_cases) <> 0 THEN
    RAISE EXCEPTION 'FALLO caso: un traspaso pendiente no debía crear caso';
  END IF;
END $$;

-- ------------------------------------------------------------
-- Aceptar crea el caso (Postventa Uno); el segundo recibe "Ya lo tomó"
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0860c000-0000-4000-8000-000000000003', true),
       set_config('request.jwt.claims', '{"sub":"0860c000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_c record;
BEGIN
  PERFORM public.accept_handoff(current_setting('t086.h1')::uuid);
  PERFORM public.accept_handoff(current_setting('t086.h2')::uuid);

  SELECT * INTO v_c FROM public.postventa_cases WHERE handoff_id = current_setting('t086.h1')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FALLO caso: aceptar no creó el caso';
  END IF;
  IF v_c.status <> 'nuevo' OR v_c.topic <> 'entrega' OR v_c.origin <> 'cobranzas'
     OR v_c.contact_id <> '0860c000-0000-4000-8000-000000000301'
     OR v_c.assigned_to IS DISTINCT FROM '0860c000-0000-4000-8000-000000000003'::uuid
     OR v_c.appointment_id IS NOT NULL OR v_c.resolution_note IS NOT NULL THEN
    RAISE EXCEPTION 'FALLO caso: campos inesperados (%)', to_jsonb(v_c);
  END IF;
  PERFORM set_config('t086.case1', v_c.id::text, true);
  PERFORM set_config('t086.case2',
    (SELECT id FROM public.postventa_cases WHERE handoff_id = current_setting('t086.h2')::uuid)::text, true);
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', '0860c000-0000-4000-8000-000000000004', true),
       set_config('request.jwt.claims', '{"sub":"0860c000-0000-4000-8000-000000000004","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_msg text;
BEGIN
  BEGIN
    PERFORM public.accept_handoff(current_setting('t086.h1')::uuid);
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%ya lo tom%' THEN
    RAISE EXCEPTION 'FALLO doble aceptación: mensaje %', v_msg;
  END IF;
  IF (SELECT count(*) FROM public.postventa_cases WHERE handoff_id = current_setting('t086.h1')::uuid) <> 1 THEN
    RAISE EXCEPTION 'FALLO doble aceptación: debía quedar un solo caso';
  END IF;
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- Sin módulo: no ve casos, no escribe directo, los RPC lo rechazan
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0860c000-0000-4000-8000-000000000005', true),
       set_config('request.jwt.claims', '{"sub":"0860c000-0000-4000-8000-000000000005","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_msg text;
BEGIN
  IF (SELECT count(*) FROM public.postventa_cases) <> 0 THEN
    RAISE EXCEPTION 'FALLO RLS: marketing ve casos de postventa';
  END IF;
  IF (SELECT count(*) FROM public.postventa_cases_list(NULL)) <> 0 THEN
    RAISE EXCEPTION 'FALLO lista: marketing recibió casos';
  END IF;
  BEGIN
    PERFORM public.postventa_resolve_case(current_setting('t086.case1')::uuid, 'intento');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%no encontrado%' THEN
    RAISE EXCEPTION 'FALLO resolver sin módulo: mensaje %', v_msg;
  END IF;
  v_msg := NULL;
  BEGIN
    UPDATE public.postventa_cases SET status = 'resuelto';
  EXCEPTION WHEN insufficient_privilege THEN v_msg := 'denegado';
  END;
  IF v_msg IS DISTINCT FROM 'denegado' THEN
    RAISE EXCEPTION 'FALLO escritura directa: UPDATE no fue denegado';
  END IF;
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- Lista de casos; gerencia ve; otra cuenta no
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0860c000-0000-4000-8000-000000000003', true),
       set_config('request.jwt.claims', '{"sub":"0860c000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_row jsonb;
BEGIN
  IF (SELECT count(*) FROM public.postventa_cases_list(NULL)) <> 2 THEN
    RAISE EXCEPTION 'FALLO lista: % casos (esperado 2)', (SELECT count(*) FROM public.postventa_cases_list(NULL));
  END IF;
  IF (SELECT count(*) FROM public.postventa_cases_list('nuevo')) <> 2
     OR (SELECT count(*) FROM public.postventa_cases_list('resuelto')) <> 0 THEN
    RAISE EXCEPTION 'FALLO lista: el filtro por estado no cuadra';
  END IF;
  SELECT r INTO v_row FROM public.postventa_cases_list(NULL) r WHERE r->>'id' = current_setting('t086.case1');
  IF v_row->>'status' <> 'nuevo' OR v_row->>'topic' <> 'entrega' OR v_row->>'origin' <> 'cobranzas'
     OR v_row->>'note' IS DISTINCT FROM 'Quiere ver su lote'
     OR v_row->'summary'->>'cliente' IS DISTINCT FROM 'Cliente 086'
     OR v_row->'summary'->>'telefono' IS DISTINCT FROM '+51900086086'
     OR v_row->>'assigned_to_name' IS DISTINCT FROM 'Postventa Uno 086'
     OR v_row->'appointment' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'FALLO lista: fila inesperada %', v_row;
  END IF;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', '0860c000-0000-4000-8000-000000000006', true),
       set_config('request.jwt.claims', '{"sub":"0860c000-0000-4000-8000-000000000006","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.postventa_cases) <> 2 THEN
    RAISE EXCEPTION 'FALLO gerencia: debía ver los 2 casos';
  END IF;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', '0860c000-0000-4000-8000-000000000010', true),
       set_config('request.jwt.claims', '{"sub":"0860c000-0000-4000-8000-000000000010","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.postventa_cases) <> 0
     OR (SELECT count(*) FROM public.postventa_cases_list(NULL)) <> 0 THEN
    RAISE EXCEPTION 'FALLO otra cuenta: el dueño de otra cuenta ve casos ajenos';
  END IF;
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- Agendar: lunes/sábado, 7 días, franjas y un cliente por franja
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0860c000-0000-4000-8000-000000000003', true),
       set_config('request.jwt.claims', '{"sub":"0860c000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_today  date := (now() AT TIME ZONE 'America/Lima')::date;
  v_case1  uuid := current_setting('t086.case1')::uuid;
  v_case2  uuid := current_setting('t086.case2')::uuid;
  v_mon    date;
  v_sat    date;
  v_soon   date;
  v_wed    date;
  v_d      date;
  v_msg    text;
  v_appt   uuid;
  v_appt2  uuid;
  v_a      record;
  v_c      record;
BEGIN
  -- Primer lunes y primer sábado con al menos 7 días de anticipación.
  v_d := v_today + 7;
  WHILE extract(dow FROM v_d) <> 1 LOOP v_d := v_d + 1; END LOOP;
  v_mon := v_d;
  v_d := v_today + 7;
  WHILE extract(dow FROM v_d) <> 6 LOOP v_d := v_d + 1; END LOOP;
  v_sat := v_d;
  -- Un lunes o sábado a menos de 7 días.
  v_d := v_today + 1;
  WHILE extract(dow FROM v_d) NOT IN (1, 6) LOOP v_d := v_d + 1; END LOOP;
  v_soon := v_d;
  IF v_soon >= v_today + 7 THEN
    RAISE EXCEPTION 'FALLO fixture: no hallé lunes/sábado a menos de 7 días';
  END IF;
  -- Un miércoles lejano (con franja, pero no es día de visita).
  v_d := v_today + 7;
  WHILE extract(dow FROM v_d) <> 3 LOOP v_d := v_d + 1; END LOOP;
  v_wed := v_d;

  -- Miércoles: rechazado.
  BEGIN
    PERFORM public.postventa_schedule_visit(v_case1, ((v_wed::timestamp + interval '540 minutes') AT TIME ZONE 'America/Lima'));
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%lunes%' THEN
    RAISE EXCEPTION 'FALLO día: un miércoles debía rechazarse con mención a lunes/sábado (mensaje: %)', v_msg;
  END IF;

  -- Lunes/sábado con menos de 7 días.
  v_msg := NULL;
  BEGIN
    PERFORM public.postventa_schedule_visit(v_case1, ((v_soon::timestamp + interval '540 minutes') AT TIME ZONE 'America/Lima'));
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%7 días%' THEN
    RAISE EXCEPTION 'FALLO anticipación: menos de 7 días debía rechazarse (mensaje: %)', v_msg;
  END IF;

  -- Hora que no es franja (10:30).
  v_msg := NULL;
  BEGIN
    PERFORM public.postventa_schedule_visit(v_case1, ((v_mon::timestamp + interval '630 minutes') AT TIME ZONE 'America/Lima'));
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%franja%' THEN
    RAISE EXCEPTION 'FALLO franja: una hora fuera de las franjas debía rechazarse (mensaje: %)', v_msg;
  END IF;

  -- Bien: lunes 9:00.
  v_appt := public.postventa_schedule_visit(v_case1, ((v_mon::timestamp + interval '540 minutes') AT TIME ZONE 'America/Lima'));
  SELECT * INTO v_c FROM public.postventa_cases WHERE id = v_case1;
  SELECT * INTO v_a FROM public.appointments WHERE id = v_appt;
  IF v_c.status <> 'agendado' OR v_c.appointment_id IS DISTINCT FROM v_appt THEN
    RAISE EXCEPTION 'FALLO agendar: caso % cita %', v_c.status, v_c.appointment_id;
  END IF;
  IF v_a.kind <> 'visita' OR v_a.status <> 'agendada' OR v_a.minutes <> 60
     OR v_a.contact_id <> '0860c000-0000-4000-8000-000000000301'
     OR v_a.user_id <> '0860c000-0000-4000-8000-000000000003'
     OR v_a.starts_at <> ((v_mon::timestamp + interval '540 minutes') AT TIME ZONE 'America/Lima') THEN
    RAISE EXCEPTION 'FALLO agendar: cita inesperada %', to_jsonb(v_a);
  END IF;

  -- Otro cliente en la misma franja: ocupada.
  v_msg := NULL;
  BEGIN
    PERFORM public.postventa_schedule_visit(v_case2, ((v_mon::timestamp + interval '540 minutes') AT TIME ZONE 'America/Lima'));
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%ocupada%' THEN
    RAISE EXCEPTION 'FALLO franja ocupada: debía rechazarse (mensaje: %)', v_msg;
  END IF;

  -- Otro cliente en la otra franja del mismo día: sí.
  v_appt2 := public.postventa_schedule_visit(v_case2, ((v_mon::timestamp + interval '660 minutes') AT TIME ZONE 'America/Lima'));
  IF v_appt2 IS NULL THEN
    RAISE EXCEPTION 'FALLO agendar: la segunda franja del lunes debía aceptarse';
  END IF;

  -- Reagendar el caso 1 al sábado: la cita vieja queda cancelada.
  v_appt := public.postventa_schedule_visit(v_case1, ((v_sat::timestamp + interval '540 minutes') AT TIME ZONE 'America/Lima'));
  IF (SELECT status FROM public.appointments WHERE id = v_a.id) <> 'cancelada' THEN
    RAISE EXCEPTION 'FALLO reagendar: la cita anterior debía quedar cancelada';
  END IF;
  IF (SELECT count(*) FROM public.appointments
       WHERE contact_id = '0860c000-0000-4000-8000-000000000301' AND status = 'agendada') <> 1 THEN
    RAISE EXCEPTION 'FALLO reagendar: debía quedar una sola cita agendada del cliente';
  END IF;
  IF (SELECT appointment_id FROM public.postventa_cases WHERE id = v_case1) IS DISTINCT FROM v_appt THEN
    RAISE EXCEPTION 'FALLO reagendar: el caso no apunta a la cita nueva';
  END IF;

  -- La lista muestra la cita.
  IF (SELECT (r->'appointment'->>'minutes')::int FROM public.postventa_cases_list('agendado') r
       WHERE r->>'id' = v_case1::text) IS DISTINCT FROM 60 THEN
    RAISE EXCEPTION 'FALLO lista: el caso agendado no trae su cita';
  END IF;

  PERFORM set_config('t086.appt1', v_appt::text, true);
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- Resolver: la nota es obligatoria; la cita queda cumplida; ya no se agenda
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0860c000-0000-4000-8000-000000000003', true),
       set_config('request.jwt.claims', '{"sub":"0860c000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_case1 uuid := current_setting('t086.case1')::uuid;
  v_msg   text;
  v_c     record;
BEGIN
  BEGIN
    PERFORM public.postventa_resolve_case(v_case1, '   ');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%nota%' THEN
    RAISE EXCEPTION 'FALLO resolver: sin nota debía rechazarse (mensaje: %)', v_msg;
  END IF;

  PERFORM public.postventa_resolve_case(v_case1, 'Se hizo la visita al lote');
  SELECT * INTO v_c FROM public.postventa_cases WHERE id = v_case1;
  IF v_c.status <> 'resuelto' OR v_c.resolution_note <> 'Se hizo la visita al lote' OR v_c.resolved_at IS NULL THEN
    RAISE EXCEPTION 'FALLO resolver: caso %', to_jsonb(v_c);
  END IF;
  IF (SELECT status FROM public.appointments WHERE id = current_setting('t086.appt1')::uuid) <> 'cumplida' THEN
    RAISE EXCEPTION 'FALLO resolver: la cita debía quedar cumplida';
  END IF;

  v_msg := NULL;
  BEGIN
    PERFORM public.postventa_schedule_visit(v_case1, now() + interval '30 days');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%resuelto%' THEN
    RAISE EXCEPTION 'FALLO agendar resuelto: debía rechazarse (mensaje: %)', v_msg;
  END IF;

  v_msg := NULL;
  BEGIN
    PERFORM public.postventa_resolve_case(v_case1, 'otra vez');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%resuelto%' THEN
    RAISE EXCEPTION 'FALLO resolver dos veces: mensaje %', v_msg;
  END IF;

  -- Un caso con cita agendada también se resuelve sin pasos extra (caso 2 estaba agendado).
  PERFORM public.postventa_resolve_case(current_setting('t086.case2')::uuid, 'Se resolvió por teléfono');
  IF (SELECT status FROM public.postventa_cases WHERE id = current_setting('t086.case2')::uuid) <> 'resuelto' THEN
    RAISE EXCEPTION 'FALLO resolver: el caso 2 no quedó resuelto';
  END IF;
END $$;
RESET ROLE;

SELECT '086: todos los casos OK' AS resultado;

ROLLBACK;
