-- ============================================================
-- 094_casos.sql — Casos de la migración 094 (caja chica por área)
--
-- Cómo correrlo: DESPUÉS de aplicar 094, pegar todo en el SQL Editor de
-- Supabase (corre como postgres). Cada caso lanza RAISE EXCEPTION 'FALLO ...'
-- si algo no cuadra; si llega al final imprime "094: todos los casos OK".
-- Todo va dentro de una transacción que termina en ROLLBACK: no deja datos.
--
-- Suplantación como en 092_casos.sql. Prefijo de ids 0940c000-. GUC: t094.acc.
--
-- Qué demuestra: el dueño y gerencia ven todas las cajas en el panel;
-- Administración y Contabilidad solo la caja principal (id = cuenta), no
-- pueden pedir otra caja y solo clasifican gastos de la principal.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_owner uuid := '0940c000-0000-4000-8000-000000000001';
  v_admin uuid := '0940c000-0000-4000-8000-000000000002';  -- administracion
  v_conta uuid := '0940c000-0000-4000-8000-000000000003';  -- contabilidad
  v_ger   uuid := '0940c000-0000-4000-8000-000000000004';  -- gerencia (agent)
  v_acc   uuid;
  v_otra  uuid := '0940c000-0000-4000-8000-000000000501';
  v_today date := (now() AT TIME ZONE 'America/Lima')::date;
  r       record;
BEGIN
  FOR r IN SELECT * FROM (VALUES (v_owner, 't094-owner@example.test'), (v_admin, 't094-admin@example.test'),
                                 (v_conta, 't094-conta@example.test'), (v_ger, 't094-ger@example.test')) AS u(id, email)
  LOOP
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES (r.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            r.email, jsonb_build_object('full_name', r.email), now(), now());
  END LOOP;

  SELECT account_id INTO v_acc FROM public.profiles WHERE user_id = v_owner;
  IF v_acc IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Prueba 094', v_owner) RETURNING id INTO v_acc;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_owner, 'Dueño 094', 't094-owner@example.test', v_acc, 'owner');
  END IF;
  UPDATE public.accounts SET status = 'active' WHERE id = v_acc;
  PERFORM set_config('t094.acc', v_acc::text, true);

  FOR r IN SELECT * FROM (VALUES
      (v_admin, 'administracion', 'Administración 094'),
      (v_conta, 'contabilidad', 'Conta 094'),
      (v_ger,   'gerencia', 'Gerencia 094')) AS m(id, area, full_name)
  LOOP
    UPDATE public.profiles SET account_id = v_acc, account_role = 'agent', area = r.area, full_name = r.full_name
     WHERE user_id = r.id;
    IF NOT FOUND THEN
      INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, area)
      VALUES (r.id, r.full_name, r.id::text || '@example.test', v_acc, 'agent', r.area);
    END IF;
  END LOOP;

  -- Caja principal (mismo id que la cuenta, como la deja la 065) y otra caja.
  INSERT INTO public.cash_companies (id, account_id, name, created_by)
  VALUES (v_acc, v_acc, 'Principal 094', v_owner) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.cash_companies (id, account_id, name, created_by)
  VALUES (v_otra, v_acc, 'Otro negocio 094', v_owner);

  -- La auditoría de la caja anota quién registra: el dueño.
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  INSERT INTO public.cash_entries (id, account_id, company_id, request_id, kind, amount_cents, concept,
                                   counterparty, occurred_on, created_by, actor_name)
  VALUES ('0940c000-0000-4000-8000-000000000601', v_acc, v_acc, gen_random_uuid(), 'expense', 1000,
          'Gasto principal 094', 'Proveedor', v_today, v_owner, 'Dueño 094'),
         ('0940c000-0000-4000-8000-000000000602', v_acc, v_otra, gen_random_uuid(), 'expense', 7000,
          'Gasto otro negocio 094', 'Proveedor', v_today, v_owner, 'Dueño 094');
END $$;

-- ------------------------------------------------------------
-- 1. Panel: quién ve qué cajas y qué gasto total
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  u record; v jsonb; v_cajas int; v_total bigint;
BEGIN
  FOR u IN SELECT * FROM (VALUES
      ('0940c000-0000-4000-8000-000000000001'::uuid, 'dueño', 2, 8000::bigint),
      ('0940c000-0000-4000-8000-000000000004'::uuid, 'gerencia', 2, 8000::bigint),
      ('0940c000-0000-4000-8000-000000000002'::uuid, 'administración', 1, 1000::bigint),
      ('0940c000-0000-4000-8000-000000000003'::uuid, 'contabilidad', 1, 1000::bigint)) AS x(id, nombre, cajas, total)
  LOOP
    PERFORM set_config('request.jwt.claim.sub', u.id::text, true);
    v := public.cash_management_panel(NULL, NULL);
    v_cajas := jsonb_array_length(v->'companies');
    v_total := (v->>'totalCents')::bigint;
    IF v_cajas <> u.cajas OR v_total <> u.total THEN
      RAISE EXCEPTION 'FALLO panel %: % cajas y total % (esperado % y %)', u.nombre, v_cajas, v_total, u.cajas, u.total;
    END IF;
    IF jsonb_array_length(v->'byCompany') <> u.cajas THEN
      RAISE EXCEPTION 'FALLO desglose por caja de %', u.nombre;
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 2. Administración no puede pedir la otra caja; sí la principal
-- ------------------------------------------------------------
DO $$
DECLARE v_msg text; v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0940c000-0000-4000-8000-000000000002', true);
  BEGIN
    PERFORM public.cash_management_panel(NULL, '0940c000-0000-4000-8000-000000000501');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL OR v_msg NOT LIKE '%Caja no válida%' THEN
    RAISE EXCEPTION 'FALLO: administración pidió otra caja y obtuvo %', COALESCE(v_msg, 'datos');
  END IF;
  v := public.cash_management_panel(NULL, current_setting('t094.acc')::uuid);
  IF (v->>'totalCents')::bigint <> 1000 THEN
    RAISE EXCEPTION 'FALLO: administración no ve su caja principal';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. Clasificar: administración solo en la caja principal
-- ------------------------------------------------------------
DO $$
DECLARE v_msg text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0940c000-0000-4000-8000-000000000002', true);
  BEGIN
    PERFORM public.cash_classify_entry('0940c000-0000-4000-8000-000000000602', NULL, true, 'otros');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM; END;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'FALLO: administración clasificó un gasto de otra caja';
  END IF;
  PERFORM public.cash_classify_entry('0940c000-0000-4000-8000-000000000601', NULL, true, 'otros');

  -- El dueño sí clasifica en la otra caja.
  PERFORM set_config('request.jwt.claim.sub', '0940c000-0000-4000-8000-000000000001', true);
  PERFORM public.cash_classify_entry('0940c000-0000-4000-8000-000000000602', NULL, true, 'otros');
END $$;
RESET ROLE;

SELECT '094: todos los casos OK' AS resultado;
ROLLBACK;
