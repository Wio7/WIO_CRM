-- ============================================================
-- 095_casos.sql — Casos de la migración 095 (caja completa de solo lectura)
--
-- Cómo correrlo: DESPUÉS de aplicar 094 y 095, pegar todo en el SQL Editor de
-- Supabase (corre como postgres). Cada caso lanza RAISE EXCEPTION 'FALLO ...'
-- si algo no cuadra; si llega al final imprime "095: todos los casos OK".
-- Todo va dentro de una transacción que termina en ROLLBACK: no deja datos.
-- Prefijo de ids 0950c000-. GUC: t095.acc.
--
-- Qué demuestra: Administración ve la caja principal completa (saldo,
-- ingresos, gastos, movimientos, anulaciones), no ve la otra caja ni puede
-- pedirla; el dueño ve las dos; un área sin acceso al panel no ve nada.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_owner uuid := '0950c000-0000-4000-8000-000000000001';
  v_admin uuid := '0950c000-0000-4000-8000-000000000002';  -- administracion
  v_mkt   uuid := '0950c000-0000-4000-8000-000000000003';  -- marketing (sin acceso al panel)
  v_acc   uuid;
  v_otra  uuid := '0950c000-0000-4000-8000-000000000501';
  v_today date := (now() AT TIME ZONE 'America/Lima')::date;
  r       record;
BEGIN
  FOR r IN SELECT * FROM (VALUES (v_owner, 't095-owner@example.test'), (v_admin, 't095-admin@example.test'),
                                 (v_mkt, 't095-mkt@example.test')) AS u(id, email)
  LOOP
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES (r.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            r.email, jsonb_build_object('full_name', r.email), now(), now());
  END LOOP;

  SELECT account_id INTO v_acc FROM public.profiles WHERE user_id = v_owner;
  IF v_acc IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Prueba 095', v_owner) RETURNING id INTO v_acc;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_owner, 'Dueño 095', 't095-owner@example.test', v_acc, 'owner');
  END IF;
  UPDATE public.accounts SET status = 'active' WHERE id = v_acc;
  PERFORM set_config('t095.acc', v_acc::text, true);

  FOR r IN SELECT * FROM (VALUES (v_admin, 'administracion', 'Administración 095'),
                                 (v_mkt, 'marketing', 'Marketing 095')) AS m(id, area, full_name)
  LOOP
    UPDATE public.profiles SET account_id = v_acc, account_role = 'agent', area = r.area, full_name = r.full_name
     WHERE user_id = r.id;
    IF NOT FOUND THEN
      INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, area)
      VALUES (r.id, r.full_name, r.id::text || '@example.test', v_acc, 'agent', r.area);
    END IF;
  END LOOP;

  INSERT INTO public.cash_companies (id, account_id, name, created_by)
  VALUES (v_acc, v_acc, 'Principal 095', v_owner) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.cash_companies (id, account_id, name, created_by)
  VALUES (v_otra, v_acc, 'Otro negocio 095', v_owner);

  -- Principal: ingreso 50.00, gasto 10.00 y gasto 3.00 que luego se anula.
  -- Otra caja: gasto 70.00.
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  INSERT INTO public.cash_entries (id, account_id, company_id, request_id, kind, amount_cents, concept,
                                   counterparty, occurred_on, created_by, actor_name)
  VALUES ('0950c000-0000-4000-8000-000000000601', v_acc, v_acc, gen_random_uuid(), 'income', 5000,
          'Fondo 095', 'Gerencia', v_today, v_owner, 'Dueño 095'),
         ('0950c000-0000-4000-8000-000000000602', v_acc, v_acc, gen_random_uuid(), 'expense', 1000,
          'Útiles 095', 'Librería', v_today, v_owner, 'Dueño 095'),
         ('0950c000-0000-4000-8000-000000000603', v_acc, v_acc, gen_random_uuid(), 'expense', 300,
          'Error 095', 'Tienda', v_today, v_owner, 'Dueño 095'),
         ('0950c000-0000-4000-8000-000000000604', v_acc, v_otra, gen_random_uuid(), 'expense', 7000,
          'Gasto otro negocio 095', 'Proveedor', v_today, v_owner, 'Dueño 095');
  -- Anulación del gasto de 3.00 (como la hace Golden Caja: tipo contrario + reversal_of).
  INSERT INTO public.cash_entries (account_id, company_id, request_id, kind, amount_cents, concept,
                                   counterparty, occurred_on, reversal_of, created_by, actor_name)
  VALUES (v_acc, v_acc, gen_random_uuid(), 'income', 300, 'Anulación: error', 'Tienda', v_today,
          '0950c000-0000-4000-8000-000000000603', v_owner, 'Dueño 095');
END $$;

SET LOCAL ROLE authenticated;

-- 1. Administración: la caja principal completa
DO $$
DECLARE v jsonb; v_anulado boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0950c000-0000-4000-8000-000000000002', true);
  v := public.cash_area_snapshot(NULL, NULL);
  IF (v->>'companyId')::uuid <> current_setting('t095.acc')::uuid THEN
    RAISE EXCEPTION 'FALLO: administración no recibió la caja principal';
  END IF;
  IF (v->>'incomeCents')::bigint <> 5000 OR (v->>'expenseCents')::bigint <> 1000 THEN
    RAISE EXCEPTION 'FALLO montos: ingresos % gastos % (esperado 5000 y 1000)', v->>'incomeCents', v->>'expenseCents';
  END IF;
  IF jsonb_array_length(v->'entries') <> 3 OR (v->>'entryCount')::int <> 3 THEN
    RAISE EXCEPTION 'FALLO movimientos: % (esperado 3, sin la fila de anulación)', jsonb_array_length(v->'entries');
  END IF;
  SELECT (e->>'reversed')::boolean INTO v_anulado FROM jsonb_array_elements(v->'entries') e
   WHERE e->>'id' = '0950c000-0000-4000-8000-000000000603';
  IF v_anulado IS NOT TRUE THEN RAISE EXCEPTION 'FALLO: el gasto anulado no sale como anulado'; END IF;
  IF jsonb_array_length(v->'companies') <> 1 THEN
    RAISE EXCEPTION 'FALLO: administración ve % cajas (esperado 1)', jsonb_array_length(v->'companies');
  END IF;
  IF jsonb_array_length(v->'byMonth') <> 12 THEN RAISE EXCEPTION 'FALLO: faltan meses'; END IF;
END $$;

-- 2. Administración no puede pedir la otra caja
DO $$
DECLARE v_msg text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0950c000-0000-4000-8000-000000000002', true);
  BEGIN
    PERFORM public.cash_area_snapshot('0950c000-0000-4000-8000-000000000501', NULL);
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL OR v_msg NOT LIKE '%Caja no válida%' THEN
    RAISE EXCEPTION 'FALLO: administración pidió otra caja y obtuvo %', COALESCE(v_msg, 'datos');
  END IF;
END $$;

-- 3. El dueño ve las dos cajas y la otra con su gasto
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0950c000-0000-4000-8000-000000000001', true);
  v := public.cash_area_snapshot('0950c000-0000-4000-8000-000000000501', NULL);
  IF (v->>'expenseCents')::bigint <> 7000 OR jsonb_array_length(v->'companies') <> 2 THEN
    RAISE EXCEPTION 'FALLO dueño: gastos % y % cajas', v->>'expenseCents', jsonb_array_length(v->'companies');
  END IF;
END $$;

-- 4. Un área sin acceso al panel no ve nada
DO $$
DECLARE v_msg text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0950c000-0000-4000-8000-000000000003', true);
  BEGIN
    PERFORM public.cash_area_snapshot(NULL, NULL);
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL OR v_msg NOT LIKE '%Sin acceso%' THEN
    RAISE EXCEPTION 'FALLO: marketing vio la caja (%)', COALESCE(v_msg, 'datos');
  END IF;
END $$;
RESET ROLE;

SELECT '095: todos los casos OK' AS resultado;
ROLLBACK;
