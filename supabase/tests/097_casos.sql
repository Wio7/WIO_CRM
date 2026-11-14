-- ============================================================
-- 097_casos.sql — Casos de la migración 097 (app de Gerencia, tarea 1)
--
-- Cómo correrlo: DESPUÉS de aplicar 097, pegar todo en el SQL Editor de
-- Supabase (corre como postgres). Cada caso lanza RAISE EXCEPTION 'FALLO ...'
-- si algo no cuadra; si llega al final imprime "097: todos los casos OK".
-- Todo va dentro de una transacción que termina en ROLLBACK: no deja datos.
-- Prefijo de ids 0970c000-. GUC: t097.acc, t097.acc2.
--
-- Qué demuestra: gerente y dueño tienen rol 'gerencia', cobranzas no; el
-- gerente pone, cambia y borra metas (total y por proyecto); cobranzas no
-- puede escribir ni leer; la otra cuenta no ve ni toca las metas de Golden;
-- tipo inválido -> 22023; proyecto ajeno -> 22023; el mes se normaliza.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_owner  uuid := '0970c000-0000-4000-8000-000000000001';
  v_ger    uuid := '0970c000-0000-4000-8000-000000000002';  -- área gerencia
  v_cob    uuid := '0970c000-0000-4000-8000-000000000003';  -- cobranzas
  v_owner2 uuid := '0970c000-0000-4000-8000-000000000011';  -- dueño de la otra cuenta
  v_ger2   uuid := '0970c000-0000-4000-8000-000000000012';  -- gerente de la otra cuenta
  v_acc    uuid;
  v_acc2   uuid;
  r        record;
BEGIN
  FOR r IN SELECT * FROM (VALUES (v_owner, 't097-owner@example.test'), (v_ger, 't097-ger@example.test'),
                                 (v_cob, 't097-cob@example.test'), (v_owner2, 't097-owner2@example.test'),
                                 (v_ger2, 't097-ger2@example.test')) AS u(id, email)
  LOOP
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES (r.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            r.email, jsonb_build_object('full_name', r.email), now(), now());
  END LOOP;

  -- Si la base real ya les creó perfil, se reutiliza la cuenta del dueño.
  SELECT account_id INTO v_acc FROM public.profiles WHERE user_id = v_owner;
  IF v_acc IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Prueba 097', v_owner) RETURNING id INTO v_acc;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_owner, 'Dueño 097', 't097-owner@example.test', v_acc, 'owner');
  END IF;
  UPDATE public.accounts SET status = 'active' WHERE id = v_acc;
  PERFORM set_config('t097.acc', v_acc::text, true);

  FOR r IN SELECT * FROM (VALUES (v_ger, 'gerencia', 'Gerente 097'), (v_cob, 'cobranzas', 'Cobranzas 097')) AS m(id, area, full_name)
  LOOP
    UPDATE public.profiles SET account_id = v_acc, account_role = 'agent', area = r.area, full_name = r.full_name
     WHERE user_id = r.id;
    IF NOT FOUND THEN
      INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, area)
      VALUES (r.id, r.full_name, r.id::text || '@example.test', v_acc, 'agent', r.area);
    END IF;
  END LOOP;

  -- Otra cuenta con su dueño y su gerente.
  SELECT account_id INTO v_acc2 FROM public.profiles WHERE user_id = v_owner2;
  IF v_acc2 IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Otra 097', v_owner2) RETURNING id INTO v_acc2;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_owner2, 'Dueño otra 097', 't097-owner2@example.test', v_acc2, 'owner');
  END IF;
  UPDATE public.accounts SET status = 'active' WHERE id = v_acc2;
  PERFORM set_config('t097.acc2', v_acc2::text, true);
  UPDATE public.profiles SET account_id = v_acc2, account_role = 'agent', area = 'gerencia', full_name = 'Gerente otra 097'
   WHERE user_id = v_ger2;
  IF NOT FOUND THEN
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, area)
    VALUES (v_ger2, 'Gerente otra 097', 't097-ger2@example.test', v_acc2, 'agent', 'gerencia');
  END IF;

  -- Proyectos: uno de Golden y uno de la otra cuenta.
  INSERT INTO public.real_estate_projects (id, account_id, name) VALUES
    ('0970c000-0000-4000-8000-000000000101', v_acc, 'Proyecto 097'),
    ('0970c000-0000-4000-8000-000000000109', v_acc2, 'Proyecto ajeno 097');
END $$;

SET LOCAL ROLE authenticated;

-- 1. gerencia_my_access devuelve el rol correcto
DO $$
DECLARE v jsonb; v_acc uuid := current_setting('t097.acc')::uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0970c000-0000-4000-8000-000000000002', true);
  v := public.gerencia_my_access();
  IF v->>'rol' IS DISTINCT FROM 'gerencia' OR (v->>'accountId')::uuid IS DISTINCT FROM v_acc THEN RAISE EXCEPTION 'FALLO my_access gerente: %', v; END IF;

  PERFORM set_config('request.jwt.claim.sub', '0970c000-0000-4000-8000-000000000001', true);
  IF public.gerencia_my_access()->>'rol' IS DISTINCT FROM 'gerencia' THEN RAISE EXCEPTION 'FALLO: el dueño debe tener rol gerencia'; END IF;

  PERFORM set_config('request.jwt.claim.sub', '0970c000-0000-4000-8000-000000000003', true);
  v := public.gerencia_my_access();
  IF v->'rol' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'FALLO my_access cobranzas: %', v; END IF;
END $$;

-- 2. El gerente pone, cambia y borra metas
DO $$
DECLARE g jsonb; v_p1 uuid := '0970c000-0000-4000-8000-000000000101';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0970c000-0000-4000-8000-000000000002', true);
  PERFORM public.gerencia_set_goal('2026-11-01', NULL, 'cobranza', 5000000);
  PERFORM public.gerencia_set_goal('2026-11-01', v_p1, 'cobranza', 2000000);
  g := public.gerencia_goals('2026-11-01');
  IF jsonb_array_length(g) IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'FALLO: se esperaban 2 metas, %', g; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(g) x WHERE x->'projectId' = 'null'::jsonb AND x->>'kind' = 'cobranza' AND (x->>'value')::bigint = 5000000)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(g) x WHERE x->>'projectId' = v_p1::text AND (x->>'value')::bigint = 2000000) THEN
    RAISE EXCEPTION 'FALLO: contenido de metas %', g; END IF;

  -- Repetir actualiza (con proyecto NULL también): siguen 2 filas.
  PERFORM public.gerencia_set_goal('2026-11-01', NULL, 'cobranza', 6000000);
  PERFORM public.gerencia_set_goal('2026-11-01', v_p1, 'cobranza', 2500000);
  g := public.gerencia_goals('2026-11-01');
  IF jsonb_array_length(g) IS DISTINCT FROM 2 OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(g) x WHERE x->'projectId' = 'null'::jsonb AND (x->>'value')::bigint = 6000000) THEN
    RAISE EXCEPTION 'FALLO: repetir debe actualizar, %', g; END IF;

  -- Meta de ventas (unidades) y otro mes no se mezclan.
  PERFORM public.gerencia_set_goal('2026-11-01', NULL, 'ventas', 8);
  PERFORM public.gerencia_set_goal('2026-12-01', NULL, 'cobranza', 100);
  g := public.gerencia_goals('2026-11-01');
  IF jsonb_array_length(g) IS DISTINCT FROM 3 OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(g) x WHERE x->>'kind' = 'ventas' AND (x->>'value')::bigint = 8) THEN
    RAISE EXCEPTION 'FALLO: ventas o mes, %', g; END IF;
  IF jsonb_array_length(public.gerencia_goals('2026-12-01')) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'FALLO: metas de diciembre'; END IF;

  -- 0 y NULL borran.
  PERFORM public.gerencia_set_goal('2026-11-01', v_p1, 'cobranza', 0);
  PERFORM public.gerencia_set_goal('2026-11-01', NULL, 'ventas', NULL);
  g := public.gerencia_goals('2026-11-01');
  IF jsonb_array_length(g) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'FALLO: borrar con 0/NULL, %', g; END IF;
  PERFORM public.gerencia_set_goal('2026-11-01', NULL, 'cobranza', 0);
  IF jsonb_array_length(public.gerencia_goals('2026-11-01')) IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FALLO: borrar la meta total'; END IF;
END $$;

-- 3. Validaciones: tipo, proyecto ajeno, mes normalizado
DO $$
DECLARE v_st text; g jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0970c000-0000-4000-8000-000000000002', true);
  BEGIN PERFORM public.gerencia_set_goal('2026-11-01', NULL, 'otra', 10); EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '22023' THEN RAISE EXCEPTION 'FALLO: tipo inválido debía dar 22023 (%)', v_st; END IF;

  v_st := NULL;
  BEGIN PERFORM public.gerencia_set_goal('2026-11-01', '0970c000-0000-4000-8000-000000000109', 'cobranza', 10);
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '22023' THEN RAISE EXCEPTION 'FALLO: proyecto ajeno debía dar 22023 (%)', v_st; END IF;

  PERFORM public.gerencia_set_goal('2026-11-17', NULL, 'cobranza', 123);
  g := public.gerencia_goals('2026-11-30');
  IF jsonb_array_length(g) IS DISTINCT FROM 1 OR (g->0->>'value')::bigint IS DISTINCT FROM 123 THEN RAISE EXCEPTION 'FALLO: mes no normalizado, %', g; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.management_goals WHERE month = '2026-11-01' AND amount_cents = 123) THEN
    RAISE EXCEPTION 'FALLO: el mes debía guardarse como primer día'; END IF;
END $$;

-- 4. Cobranzas no escribe ni lee; la otra cuenta no ve ni toca las metas
DO $$
DECLARE v_st text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0970c000-0000-4000-8000-000000000003', true);
  BEGIN PERFORM public.gerencia_set_goal('2026-11-01', NULL, 'cobranza', 10); EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'FALLO: cobranzas set_goal debía dar 42501 (%)', v_st; END IF;
  v_st := NULL;
  BEGIN PERFORM public.gerencia_goals('2026-11-01'); EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'FALLO: cobranzas goals debía dar 42501 (%)', v_st; END IF;
  IF EXISTS (SELECT 1 FROM public.management_goals) THEN RAISE EXCEPTION 'FALLO: cobranzas ve metas con SELECT directo'; END IF;
  v_st := NULL;
  BEGIN INSERT INTO public.management_goals (account_id, month, kind, amount_cents)
        VALUES (current_setting('t097.acc')::uuid, '2026-11-01', 'cobranza', 1);
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS NULL THEN RAISE EXCEPTION 'FALLO: INSERT directo en management_goals debía fallar'; END IF;

  -- Gerente de la otra cuenta: no ve las de Golden y sus metas no pisan las de Golden.
  PERFORM set_config('request.jwt.claim.sub', '0970c000-0000-4000-8000-000000000012', true);
  IF EXISTS (SELECT 1 FROM public.management_goals) THEN RAISE EXCEPTION 'FALLO: la otra cuenta ve metas de Golden'; END IF;
  IF jsonb_array_length(public.gerencia_goals('2026-11-01')) IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'FALLO: goals de la otra cuenta'; END IF;
  PERFORM public.gerencia_set_goal('2026-11-01', NULL, 'cobranza', 999);
  IF (SELECT count(*) FROM public.management_goals) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'FALLO: la otra cuenta debe ver solo la suya'; END IF;
  PERFORM set_config('request.jwt.claim.sub', '0970c000-0000-4000-8000-000000000002', true);
  IF (public.gerencia_goals('2026-11-01')->0->>'value')::bigint IS DISTINCT FROM 123 THEN RAISE EXCEPTION 'FALLO: la meta de Golden fue pisada'; END IF;
END $$;
RESET ROLE;

SELECT '097: todos los casos OK' AS resultado;
ROLLBACK;
