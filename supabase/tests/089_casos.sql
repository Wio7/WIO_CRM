-- ============================================================
-- 089_casos.sql — Casos de la migración 089 (área Promueve)
--
-- Cómo correrlo: DESPUÉS de aplicar 089, pegar todo en el SQL Editor de
-- Supabase (corre como postgres). Cada caso es un DO que lanza
-- RAISE EXCEPTION 'FALLO ...' si algo no cuadra; si llega al final sin
-- error, imprime "089: todos los casos OK". Todo va dentro de una
-- transacción que termina en ROLLBACK: no deja datos.
--
-- Suplantación como en 087_casos.sql (set_config + SET LOCAL ROLE
-- authenticated; RESET ROLE vuelve a postgres). Prefijo de ids 0890c000-.
-- GUC: t089.acc, t089.contact, t089.plan.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- Fixtures (como postgres)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_owner uuid := '0890c000-0000-4000-8000-000000000001';
  v_asesor uuid := '0890c000-0000-4000-8000-000000000002';  -- asesor de la empresa (sin área)
  v_ger   uuid := '0890c000-0000-4000-8000-000000000003';   -- gerencia
  v_pro   uuid := '0890c000-0000-4000-8000-000000000004';   -- Promueve ya registrado
  v_adm   uuid := '0890c000-0000-4000-8000-000000000005';   -- administrador
  v_acc   uuid;
  v_contact uuid := '0890c000-0000-4000-8000-0000000000c1';
  v_plan  uuid := '0890c000-0000-4000-8000-0000000000a1';
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (v_owner, 't089-owner@example.test'), (v_asesor, 't089-asesor@example.test'),
      (v_ger, 't089-ger@example.test'), (v_pro, 't089-pro@example.test'),
      (v_adm, 't089-adm@example.test')
    ) AS u(id, email)
  LOOP
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES (r.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            r.email, jsonb_build_object('full_name', r.email), now(), now());
  END LOOP;

  SELECT account_id INTO v_acc FROM public.profiles WHERE user_id = v_owner;
  IF v_acc IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Prueba 089', v_owner) RETURNING id INTO v_acc;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_owner, 'Dueño 089', 't089-owner@example.test', v_acc, 'owner');
  END IF;
  UPDATE public.accounts SET status = 'active' WHERE id = v_acc;
  -- Peor caso: la cuenta deja ver todas las conversaciones a cualquier agente.
  UPDATE public.accounts SET agents_see_only_assigned = false WHERE id = v_acc
    AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'agents_see_only_assigned');

  FOR r IN
    SELECT * FROM (VALUES
      (v_asesor, 'agent'::account_role_enum, NULL::text,   'Asesor 089'),
      (v_ger,    'agent'::account_role_enum, 'gerencia',   'Gerencia 089'),
      (v_pro,    'agent'::account_role_enum, NULL::text,   'Externo 089'),
      (v_adm,    'admin'::account_role_enum, NULL::text,   'Admin 089')
    ) AS m(id, role, area, full_name)
  LOOP
    UPDATE public.profiles SET account_id = v_acc, account_role = r.role, area = r.area, full_name = r.full_name
     WHERE user_id = r.id;
    IF NOT FOUND THEN
      INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, area)
      VALUES (r.id, r.full_name, r.id::text || '@example.test', v_acc, r.role, r.area);
    END IF;
  END LOOP;
  UPDATE public.profiles SET full_name = 'Dueño 089' WHERE user_id = v_owner;

  -- Datos que un Promueve NO debe ver: un cliente del asesor con su conversación,
  -- un plan de pagos y una gestión de cobranza.
  INSERT INTO public.contacts (id, account_id, user_id, phone, name)
  VALUES (v_contact, v_acc, v_asesor, '+51999000089', 'Cliente 089');
  INSERT INTO public.payment_plans (id, account_id, contact_id, total_amount, installments_count, monthly_amount, first_due_date)
  VALUES (v_plan, v_acc, v_contact, 1000, 2, 500, current_date);
  INSERT INTO public.installments (plan_id, account_id, number, amount, due_date)
  VALUES (v_plan, v_acc, 1, 500, current_date), (v_plan, v_acc, 2, 500, current_date + 30);
  INSERT INTO public.collection_actions (account_id, contact_id, plan_id, channel, result, note, created_by)
  VALUES (v_acc, v_contact, v_plan, 'llamada', 'contactado', 'nota privada 089', v_asesor);
  INSERT INTO public.conversations (id, account_id, contact_id, user_id, assigned_agent_id)
  VALUES ('0890c000-0000-4000-8000-0000000000d1', v_acc, v_contact, v_asesor, v_asesor);

  PERFORM set_config('t089.acc', v_acc::text, true);
  PERFORM set_config('t089.contact', v_contact::text, true);
  PERFORM set_config('t089.plan', v_plan::text, true);
END $$;

-- ------------------------------------------------------------
-- 1. set_member_area acepta 'promueve' (solo a agentes) y rechaza lo demás
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0890c000-0000-4000-8000-000000000001', true),
       set_config('request.jwt.claims', '{"sub":"0890c000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.set_member_area('0890c000-0000-4000-8000-000000000004', 'promueve');
  BEGIN
    PERFORM public.set_member_area('0890c000-0000-4000-8000-000000000005', 'promueve');
    RAISE EXCEPTION 'FALLO area: a un administrador no se le puede dar Promueve';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  BEGIN
    PERFORM public.set_member_area('0890c000-0000-4000-8000-000000000002', 'inventada');
    RAISE EXCEPTION 'FALLO area: un área desconocida debía rechazarse';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
END $$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT area FROM public.profiles WHERE user_id = '0890c000-0000-4000-8000-000000000004') IS DISTINCT FROM 'promueve' THEN
    RAISE EXCEPTION 'FALLO area: el perfil debía quedar con area = promueve';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. Códigos de invitación: quién crea, que no se guarde en claro
-- ------------------------------------------------------------
-- Un asesor común NO crea ni lista códigos.
SELECT set_config('request.jwt.claim.sub', '0890c000-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"0890c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.promueve_invite_create('x');
    RAISE EXCEPTION 'FALLO codigos: un asesor no debía poder crear códigos';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  IF (SELECT count(*) FROM public.promueve_invites_list()) <> 0 THEN
    RAISE EXCEPTION 'FALLO codigos: un asesor no debía listar códigos';
  END IF;
  IF has_table_privilege('authenticated', 'public.promueve_invites', 'SELECT') THEN
    RAISE EXCEPTION 'FALLO codigos: authenticated no debía poder leer la tabla de códigos';
  END IF;
END $$;
RESET ROLE;

-- Gerencia crea un código de 1 uso y otro fijo de 2 usos.
SELECT set_config('request.jwt.claim.sub', '0890c000-0000-4000-8000-000000000003', true),
       set_config('request.jwt.claims', '{"sub":"0890c000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_r jsonb;
  v_r2 jsonb;
BEGIN
  v_r := public.promueve_invite_create('Prueba una vez', 1, NULL, NULL);
  IF (v_r->>'code') !~ '^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$' THEN
    RAISE EXCEPTION 'FALLO codigos: formato del código generado: %', v_r->>'code';
  END IF;
  PERFORM set_config('t089.code1', v_r->>'code', true);
  PERFORM set_config('t089.id1', v_r->>'id', true);
  v_r2 := public.promueve_invite_create('Prueba fija', 2, NULL, 'golden-2026x');
  IF (v_r2->>'code') <> 'GOLDEN2026X' THEN
    RAISE EXCEPTION 'FALLO codigos: código fijo debía normalizarse, vino %', v_r2->>'code';
  END IF;
  PERFORM set_config('t089.code2', v_r2->>'code', true);
  BEGIN
    PERFORM public.promueve_invite_create('dup', NULL, NULL, 'GOLDEN-2026X');
    RAISE EXCEPTION 'FALLO codigos: un código repetido debía rechazarse';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL; END;
  BEGIN
    PERFORM public.promueve_invite_create('corto', NULL, NULL, 'abc');
    RAISE EXCEPTION 'FALLO codigos: un código corto debía rechazarse';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  IF (SELECT count(*) FROM public.promueve_invites_list()) <> 2 THEN
    RAISE EXCEPTION 'FALLO codigos: gerencia debía listar sus 2 códigos';
  END IF;
  IF (SELECT bool_or(e::text LIKE '%code_hash%') FROM public.promueve_invites_list() e) THEN
    RAISE EXCEPTION 'FALLO codigos: la lista no debe mostrar el hash';
  END IF;
END $$;
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.promueve_invites WHERE code_hash LIKE '%GOLDEN%' OR code_hash = current_setting('t089.code2')) THEN
    RAISE EXCEPTION 'FALLO codigos: el código no debe guardarse en claro';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.promueve_invites WHERE code_hash = public.promueve_hash_code('golden 2026-x')) THEN
    RAISE EXCEPTION 'FALLO codigos: el hash debe ser el SHA-256 del código normalizado';
  END IF;
  IF public.promueve_check_code(public.promueve_hash_code('NOEXISTE00')) IS NOT NULL THEN
    RAISE EXCEPTION 'FALLO codigos: un código inventado no debía servir';
  END IF;
  IF public.promueve_check_code(public.promueve_hash_code(current_setting('t089.code1'))) IS DISTINCT FROM current_setting('t089.acc')::uuid THEN
    RAISE EXCEPTION 'FALLO codigos: el código válido debía devolver la cuenta';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. Registro atómico (como service_role / postgres)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_new uuid := '0890c000-0000-4000-8000-0000000000b1';
  v_new2 uuid := '0890c000-0000-4000-8000-0000000000b2';
  v_acc uuid := current_setting('t089.acc')::uuid;
  v_h1 text := public.promueve_hash_code(current_setting('t089.code1'));
  v_pers uuid;
BEGIN
  -- Lo que hace Auth + handle_new_user: usuario + cuenta personal vacía como dueño.
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (v_new, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          't089-new1@example.test', '{}', now(), now());
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = v_new) THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Personal 1', v_new) RETURNING id INTO v_pers;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_new, '', 't089-new1@example.test', v_pers, 'owner');
  END IF;
  SELECT account_id INTO v_pers FROM public.profiles WHERE user_id = v_new;

  -- Código inventado: no cambia nada.
  BEGIN
    PERFORM public.promueve_registrar(v_new, 'Nuevo Uno', '987654321', public.promueve_hash_code('INVENTADO99'));
    RAISE EXCEPTION 'FALLO registro: un código inventado no debía registrar';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  IF (SELECT account_id FROM public.profiles WHERE user_id = v_new) <> v_pers THEN
    RAISE EXCEPTION 'FALLO registro: con código inválido el perfil no debía moverse';
  END IF;

  -- Código bueno.
  IF public.promueve_registrar(v_new, '  Nuevo Uno  ', '987654321', v_h1) <> v_acc THEN
    RAISE EXCEPTION 'FALLO registro: debía devolver la cuenta de Golden';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = v_new AND account_id = v_acc
                  AND account_role = 'agent' AND area = 'promueve'
                  AND full_name = 'Nuevo Uno' AND contact_phone = '987654321') THEN
    RAISE EXCEPTION 'FALLO registro: el perfil debía quedar agent/promueve en la cuenta con nombre y celular';
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounts WHERE id = v_pers) THEN
    RAISE EXCEPTION 'FALLO registro: la cuenta personal huérfana debía borrarse';
  END IF;
  IF (SELECT uses FROM public.promueve_invites WHERE code_hash = v_h1) <> 1 THEN
    RAISE EXCEPTION 'FALLO registro: el código debía consumir un uso';
  END IF;

  -- El código de 1 uso ya no sirve.
  IF public.promueve_check_code(v_h1) IS NOT NULL THEN
    RAISE EXCEPTION 'FALLO registro: un código agotado no debía servir';
  END IF;
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (v_new2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          't089-new2@example.test', '{}', now(), now());
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = v_new2) THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Personal 2', v_new2);
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    SELECT v_new2, '', 't089-new2@example.test', a.id, 'owner' FROM public.accounts a WHERE a.owner_user_id = v_new2;
  END IF;
  BEGIN
    PERFORM public.promueve_registrar(v_new2, 'Dos', '987654322', v_h1);
    RAISE EXCEPTION 'FALLO registro: un código agotado no debía registrar';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  IF (SELECT area FROM public.profiles WHERE user_id = v_new2) IS NOT NULL THEN
    RAISE EXCEPTION 'FALLO registro: el rechazado no debía quedar con área';
  END IF;

  -- Un usuario que ya está en la cuenta (el asesor) no se "registra" otra vez.
  BEGIN
    PERFORM public.promueve_registrar('0890c000-0000-4000-8000-000000000002', 'X', '1', public.promueve_hash_code(current_setting('t089.code2')));
    RAISE EXCEPTION 'FALLO registro: un miembro actual no debía poder canjear un código';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL; END;

  -- Código desactivado.
  UPDATE public.promueve_invites SET active = false WHERE code_hash = public.promueve_hash_code(current_setting('t089.code2'));
  IF public.promueve_check_code(public.promueve_hash_code(current_setting('t089.code2'))) IS NOT NULL THEN
    RAISE EXCEPTION 'FALLO registro: un código desactivado no debía servir';
  END IF;
  -- Código vencido.
  UPDATE public.promueve_invites SET active = true, expires_at = now() - interval '1 hour'
   WHERE code_hash = public.promueve_hash_code(current_setting('t089.code2'));
  IF public.promueve_check_code(public.promueve_hash_code(current_setting('t089.code2'))) IS NOT NULL THEN
    RAISE EXCEPTION 'FALLO registro: un código vencido no debía servir';
  END IF;
END $$;

-- authenticated no puede canjear ni consultar códigos por su cuenta.
SELECT set_config('request.jwt.claim.sub', '0890c000-0000-4000-8000-000000000004', true),
       set_config('request.jwt.claims', '{"sub":"0890c000-0000-4000-8000-000000000004","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.promueve_registrar('0890c000-0000-4000-8000-000000000004', 'X', '1', 'a');
    RAISE EXCEPTION 'FALLO permisos: authenticated no debía poder llamar promueve_registrar';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  BEGIN
    PERFORM public.promueve_check_code('a');
    RAISE EXCEPTION 'FALLO permisos: authenticated no debía poder llamar promueve_check_code';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- 4. Un Promueve no ve datos de nadie (sesión suplantada)
--    Control: el asesor de la empresa SÍ ve su cliente y su conversación.
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0890c000-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"0890c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.contacts) < 1 THEN
    RAISE EXCEPTION 'FALLO control: el asesor debía ver su cliente (la prueba no sería válida)';
  END IF;
  IF (SELECT count(*) FROM public.conversations) < 1 THEN
    RAISE EXCEPTION 'FALLO control: el asesor debía ver su conversación';
  END IF;
  IF (SELECT count(*) FROM public.profiles) < 3 THEN
    RAISE EXCEPTION 'FALLO control: el asesor debía ver a sus compañeros';
  END IF;
  IF NOT public.can_access_module(current_setting('t089.acc')::uuid, 'ventas') THEN
    RAISE EXCEPTION 'FALLO control: el asesor sin área debía entrar a ventas';
  END IF;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', '0890c000-0000-4000-8000-000000000004', true),
       set_config('request.jwt.claims', '{"sub":"0890c000-0000-4000-8000-000000000004","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_acc uuid := current_setting('t089.acc')::uuid;
  m text;
  n bigint;
  t text;
BEGIN
  -- Su propio perfil sí; el de nadie más.
  IF (SELECT count(*) FROM public.profiles) <> 1
     OR (SELECT user_id FROM public.profiles) <> '0890c000-0000-4000-8000-000000000004' THEN
    RAISE EXCEPTION 'FALLO rls: un Promueve debía ver solo su propio perfil';
  END IF;

  -- Datos del CRM: cero filas.
  FOREACH t IN ARRAY ARRAY['contacts', 'conversations', 'payment_plans', 'installments', 'collection_actions',
                           'installment_payments', 'plan_prepayments', 'module_handoffs', 'account_module_members',
                           'postventa_cases', 'cash_entries', 'cash_budgets', 'store_orders', 'store_products',
                           'messages', 'real_estate_units', 'reservations', 'reservation_payments'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      IF n <> 0 THEN
        RAISE EXCEPTION 'FALLO rls: un Promueve veía % filas de %', n, t;
      END IF;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.installment_schedule) <> 0 THEN
    RAISE EXCEPTION 'FALLO rls: un Promueve veía el cronograma (installment_schedule)';
  END IF;
  IF to_regclass('public.payment_plan_balances') IS NOT NULL
     AND (SELECT count(*) FROM public.payment_plan_balances) <> 0 THEN
    RAISE EXCEPTION 'FALLO rls: un Promueve veía saldos de planes';
  END IF;

  -- Módulos y puertas: todo cerrado.
  FOREACH m IN ARRAY ARRAY['cobranzas', 'cronograma', 'legal', 'ventas', 'postventa', 'tienda'] LOOP
    IF public.can_access_module(v_acc, m) THEN
      RAISE EXCEPTION 'FALLO rls: un Promueve entraba al módulo %', m;
    END IF;
  END LOOP;
  IF public.is_account_member(v_acc, 'viewer') OR public.has_full_access(v_acc)
     OR public.is_owner_or_gerencia(v_acc) OR public.can_manage_schedule(v_acc) THEN
    RAISE EXCEPTION 'FALLO rls: un Promueve pasaba por una puerta de miembro';
  END IF;
  IF to_regprocedure('public.postventa_has_access(uuid)') IS NOT NULL AND public.postventa_has_access(v_acc) THEN
    RAISE EXCEPTION 'FALLO rls: un Promueve entraba a postventa';
  END IF;
  IF (SELECT count(*) FROM public.my_handoffs('cobranzas', 'recibidos')) <> 0
     OR (SELECT count(*) FROM public.my_handoffs('legal', 'recibidos')) <> 0 THEN
    RAISE EXCEPTION 'FALLO rls: un Promueve veía traspasos';
  END IF;

  -- No escribe en el CRM.
  BEGIN
    INSERT INTO public.contacts (account_id, user_id, phone, name) VALUES (v_acc, auth.uid(), '+51900000000', 'Intruso');
    RAISE EXCEPTION 'FALLO rls: un Promueve creó un contacto';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  BEGIN
    PERFORM public.send_handoff('pase_legal', current_setting('t089.plan')::uuid, 'x', NULL);
    RAISE EXCEPTION 'FALLO rls: un Promueve envió un traspaso';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

  -- No se cambia el área ni se mueve de cuenta, ni cambia otras áreas.
  BEGIN
    UPDATE public.profiles SET area = NULL WHERE user_id = auth.uid();
    RAISE EXCEPTION 'FALLO rls: un Promueve se quitó el área';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  BEGIN
    UPDATE public.profiles SET account_role = 'owner' WHERE user_id = auth.uid();
    RAISE EXCEPTION 'FALLO rls: un Promueve se subió el rol';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  BEGIN
    PERFORM public.set_member_area('0890c000-0000-4000-8000-000000000002', 'promueve');
    RAISE EXCEPTION 'FALLO rls: un Promueve cambió el área de otro';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  BEGIN
    PERFORM public.promueve_invite_create('x');
    RAISE EXCEPTION 'FALLO rls: un Promueve creó un código';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- 5. El reparto de chats nuevos salta a los Promueve
-- ------------------------------------------------------------
DO $$
DECLARE
  v_acc uuid := current_setting('t089.acc')::uuid;
  v_pick uuid;
BEGIN
  IF to_regclass('public.account_assignment_state') IS NULL THEN
    RAISE NOTICE '089: sin account_assignment_state en esta base, se omite el caso del reparto';
    RETURN;
  END IF;
  -- Solo Promueve y el asesor sin área: nadie recibe más de lo que le toca.
  FOR i IN 1..6 LOOP
    v_pick := public.pick_account_agent(v_acc);
    IF v_pick IS NOT NULL AND (SELECT area FROM public.profiles WHERE user_id = v_pick) IS NOT DISTINCT FROM 'promueve' THEN
      RAISE EXCEPTION 'FALLO reparto: pick_account_agent eligió a un Promueve';
    END IF;
  END LOOP;
END $$;

SELECT '089: todos los casos OK' AS resultado;

ROLLBACK;
