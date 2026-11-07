-- ============================================================
-- 084_casos.sql — Casos de la migración 084 (pagos protegidos)
--
-- Cómo correrlo: DESPUÉS de aplicar 084, pegar todo en el SQL Editor de
-- Supabase (corre como postgres). Cada caso es un DO que lanza
-- RAISE EXCEPTION 'FALLO ...' si algo no cuadra; si llega al final sin
-- error, imprime "084: todos los casos OK".
--
-- No deja datos: todo va dentro de una transacción que termina en
-- ROLLBACK (usuarios, cuenta, plan y pagos de prueba desaparecen).
--
-- Suplantación como en las pruebas de Supabase: set_config de
-- request.jwt.claims (+ request.jwt.claim.sub) y SET LOCAL ROLE
-- authenticated; RESET ROLE vuelve a postgres para preparar datos.
--
-- IDs fijos (prefijo 0840c000-...) para no pasar datos entre bloques; la
-- cuenta de prueba (la crea el trigger de alta del dueño) va en el GUC
-- t084.acc.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- Fixtures (como postgres)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_owner    uuid := '0840c000-0000-4000-8000-000000000001';
  v_cobr     uuid := '0840c000-0000-4000-8000-000000000002';
  v_ventas   uuid := '0840c000-0000-4000-8000-000000000003';
  v_legal    uuid := '0840c000-0000-4000-8000-000000000004';
  v_gerencia uuid := '0840c000-0000-4000-8000-000000000005';
  v_admin    uuid := '0840c000-0000-4000-8000-000000000006';
  v_acc      uuid;
  v_today    date := (now() AT TIME ZONE 'America/Lima')::date;
  r          record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (v_owner,    't084-owner@example.test'),
      (v_cobr,     't084-cobranzas@example.test'),
      (v_ventas,   't084-ventas@example.test'),
      (v_legal,    't084-legal@example.test'),
      (v_gerencia, 't084-gerencia@example.test'),
      (v_admin,    't084-admin@example.test')
    ) AS u(id, email)
  LOOP
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES (r.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            r.email, jsonb_build_object('full_name', r.email), now(), now());
  END LOOP;

  -- handle_new_user crea una cuenta personal y un perfil owner por usuario.
  -- La del dueño es la cuenta de prueba; si el trigger no corrió, se crea.
  SELECT account_id INTO v_acc FROM public.profiles WHERE user_id = v_owner;
  IF v_acc IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Prueba 084', v_owner) RETURNING id INTO v_acc;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_owner, 'Dueño 084', 't084-owner@example.test', v_acc, 'owner');
  END IF;

  UPDATE public.accounts
     SET status = 'active',
         late_fee_type = 'diaria', late_fee_value = 6, late_fee_grace_days = 1,
         late_fee_cap_days = 60, max_payment_parts = 3,
         resolution_installments = 2, resolution_days = 60
   WHERE id = v_acc;

  FOR r IN
    SELECT * FROM (VALUES
      (v_cobr,     'agent'::account_role_enum, 'cobranzas'),
      (v_ventas,   'agent'::account_role_enum, 'ventas'),
      (v_legal,    'agent'::account_role_enum, 'legal'),
      (v_gerencia, 'agent'::account_role_enum, 'gerencia'),
      (v_admin,    'admin'::account_role_enum, NULL)
    ) AS m(id, role, area)
  LOOP
    UPDATE public.profiles SET account_id = v_acc, account_role = r.role, area = r.area
     WHERE user_id = r.id;
    IF NOT FOUND THEN
      INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, area)
      VALUES (r.id, r.id::text, r.id::text || '@example.test', v_acc, r.role, r.area);
    END IF;
  END LOOP;

  INSERT INTO public.contacts (id, account_id, user_id, phone, name)
  VALUES ('0840c000-0000-4000-8000-000000000301', v_acc, v_owner, '+51900084084', 'Cliente 084');

  INSERT INTO public.payment_plans (id, account_id, contact_id, currency, total_amount, down_payment,
                                    installments_count, monthly_amount, due_day, first_due_date, status)
  VALUES ('0840c000-0000-4000-8000-000000000101', v_acc, '0840c000-0000-4000-8000-000000000301',
          'PEN', 1500, 0, 3, 500, NULL, v_today + 5, 'activo');

  INSERT INTO public.installments (id, plan_id, account_id, number, amount, due_date) VALUES
    ('0840c000-0000-4000-8000-000000000201', '0840c000-0000-4000-8000-000000000101', v_acc, 1, 500, v_today + 5),
    ('0840c000-0000-4000-8000-000000000202', '0840c000-0000-4000-8000-000000000101', v_acc, 2, 500, v_today + 35),
    ('0840c000-0000-4000-8000-000000000203', '0840c000-0000-4000-8000-000000000101', v_acc, 3, 500, v_today + 65);

  -- El cliente subió un voucher por una parte (lo haría el portal con service role).
  UPDATE public.installments
     SET voucher_path = 'account-x/vouchers/c/v1.jpg', declared_amount = 200,
         paid_method = 'Yape', paid_reference = '884512'
   WHERE id = '0840c000-0000-4000-8000-000000000201';

  PERFORM set_config('t084.acc', v_acc::text, true);
END $$;

-- ------------------------------------------------------------
-- Cobranzas: pago parcial 200 de 500 (aprobando el voucher del cliente)
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0840c000-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"0840c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_pay  uuid;
  v_b    record;
  v_i    record;
  v_p    record;
BEGIN
  v_pay := public.register_installment_payment(
    '0840c000-0000-4000-8000-000000000201', 200, NULL, NULL, NULL, NULL);

  SELECT * INTO v_b FROM public.installment_balances WHERE installment_id = '0840c000-0000-4000-8000-000000000201';
  IF v_b.remaining <> 300 OR v_b.paid_so_far <> 200 OR v_b.parts <> 1 THEN
    RAISE EXCEPTION 'FALLO parcial: remaining=% paid=% parts=% (esperado 300/200/1)', v_b.remaining, v_b.paid_so_far, v_b.parts;
  END IF;

  SELECT * INTO v_i FROM public.installments WHERE id = '0840c000-0000-4000-8000-000000000201';
  IF v_i.status <> 'pendiente' THEN
    RAISE EXCEPTION 'FALLO parcial: la cuota quedó %, debía seguir pendiente', v_i.status;
  END IF;
  IF v_i.voucher_path IS NOT NULL OR v_i.declared_amount IS NOT NULL THEN
    RAISE EXCEPTION 'FALLO parcial: el voucher del cliente no se limpió de la cuota';
  END IF;

  SELECT * INTO v_p FROM public.installment_payments WHERE id = v_pay;
  IF v_p.voucher_path IS DISTINCT FROM 'account-x/vouchers/c/v1.jpg'
     OR v_p.method IS DISTINCT FROM 'Yape' OR v_p.reference IS DISTINCT FROM '884512' THEN
    RAISE EXCEPTION 'FALLO parcial: el pago no se llevó voucher/método/operación del cliente (% / % / %)',
      v_p.voucher_path, v_p.method, v_p.reference;
  END IF;
  IF v_p.registered_by IS DISTINCT FROM '0840c000-0000-4000-8000-000000000002'::uuid OR v_p.legacy THEN
    RAISE EXCEPTION 'FALLO parcial: registered_by/legacy incorrectos';
  END IF;
  IF v_p.late_fee_at_payment IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FALLO parcial: mora al pagar debía ser 0 (nada vencido), es %', v_p.late_fee_at_payment;
  END IF;
END $$;

-- ------------------------------------------------------------
-- Cobranzas: pagar 600 sobre una cuota de 500 → error
-- ------------------------------------------------------------
DO $$
DECLARE
  v_msg text;
BEGIN
  BEGIN
    PERFORM public.register_installment_payment(
      '0840c000-0000-4000-8000-000000000202', 600, 'efectivo', NULL, NULL, NULL);
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%supera%' THEN
    RAISE EXCEPTION 'FALLO exceso: debía rechazar 600 sobre 500 (mensaje: %)', v_msg;
  END IF;
END $$;

-- ------------------------------------------------------------
-- Cobranzas: completar 300 → pagada; anular → vuelve a pendiente
-- ------------------------------------------------------------
DO $$
DECLARE
  v_pay uuid;
  v_b   record;
  v_st  text;
BEGIN
  v_pay := public.register_installment_payment(
    '0840c000-0000-4000-8000-000000000201', 300, 'transferencia', 'OP-2', NULL, NULL);

  SELECT * INTO v_b FROM public.installment_balances WHERE installment_id = '0840c000-0000-4000-8000-000000000201';
  SELECT status INTO v_st FROM public.installments WHERE id = '0840c000-0000-4000-8000-000000000201';
  IF v_st <> 'pagada' OR v_b.remaining <> 0 OR v_b.parts <> 2 THEN
    RAISE EXCEPTION 'FALLO completar: estado=% remaining=% parts=% (esperado pagada/0/2)', v_st, v_b.remaining, v_b.parts;
  END IF;

  PERFORM public.void_installment_payment(v_pay, 'Operación duplicada');

  SELECT * INTO v_b FROM public.installment_balances WHERE installment_id = '0840c000-0000-4000-8000-000000000201';
  SELECT status INTO v_st FROM public.installments WHERE id = '0840c000-0000-4000-8000-000000000201';
  IF v_st <> 'pendiente' OR v_b.remaining <> 300 OR v_b.parts <> 1 THEN
    RAISE EXCEPTION 'FALLO anular: estado=% remaining=% parts=% (esperado pendiente/300/1)', v_st, v_b.remaining, v_b.parts;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.installment_payments
                  WHERE id = v_pay AND voided_at IS NOT NULL AND void_reason = 'Operación duplicada') THEN
    RAISE EXCEPTION 'FALLO anular: el pago no quedó anulado con su motivo';
  END IF;
END $$;

-- ------------------------------------------------------------
-- Cobranzas: UPDATE directo de montos/estado → error (trigger)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_msg text;
BEGIN
  -- La fila es visible y editable por RLS: el error tiene que venir del trigger.
  IF (SELECT count(*) FROM public.installments WHERE id = '0840c000-0000-4000-8000-000000000202') <> 1 THEN
    RAISE EXCEPTION 'FALLO trigger: cobranzas no ve la cuota (prueba inválida)';
  END IF;
  BEGIN
    UPDATE public.installments SET amount = 1 WHERE id = '0840c000-0000-4000-8000-000000000202';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%función autorizada%' THEN
    RAISE EXCEPTION 'FALLO trigger: UPDATE installments.amount como authenticated no falló (mensaje: %)', v_msg;
  END IF;

  v_msg := NULL;
  BEGIN
    UPDATE public.installments SET status = 'pagada' WHERE id = '0840c000-0000-4000-8000-000000000202';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'FALLO trigger: UPDATE installments.status como authenticated no falló';
  END IF;

  v_msg := NULL;
  BEGIN
    UPDATE public.payment_plans SET total_amount = 1 WHERE id = '0840c000-0000-4000-8000-000000000101';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'FALLO trigger: UPDATE payment_plans.total_amount como authenticated no falló';
  END IF;

  v_msg := NULL;
  BEGIN
    INSERT INTO public.installments (plan_id, account_id, number, amount, due_date, status)
    VALUES ('0840c000-0000-4000-8000-000000000101', current_setting('t084.acc')::uuid, 9, 500, current_date, 'pagada');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'FALLO trigger: INSERT de cuota ya pagada como authenticated no falló';
  END IF;

  v_msg := NULL;
  BEGIN
    UPDATE public.installments SET declared_amount = 1 WHERE id = '0840c000-0000-4000-8000-000000000202';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'FALLO trigger: UPDATE installments.declared_amount como authenticated no falló';
  END IF;

  v_msg := NULL;
  BEGIN
    INSERT INTO public.payment_plans (account_id, contact_id, total_amount, installments_count,
                                      monthly_amount, first_due_date, collection_terms)
    VALUES (current_setting('t084.acc')::uuid, '0840c000-0000-4000-8000-000000000301', 100, 1, 100,
            current_date, '{"max_payment_parts": 99}'::jsonb);
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%términos%' THEN
    RAISE EXCEPTION 'FALLO trigger: INSERT de plan con collection_terms como authenticated no falló (mensaje: %)', v_msg;
  END IF;

  -- Una columna que no es dinero sí se puede editar.
  UPDATE public.installments SET notes = 'llamar el lunes' WHERE id = '0840c000-0000-4000-8000-000000000202';
END $$;

-- ------------------------------------------------------------
-- Cobranzas no puede abonar a capital (solo dueño/gerencia)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_msg text;
BEGIN
  BEGIN
    PERFORM public.apply_prepayment('0840c000-0000-4000-8000-000000000101', 100, 'reducir_cuota',
      '[{"id":"0840c000-0000-4000-8000-000000000203","newAmount":400}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%gerencia%' THEN
    RAISE EXCEPTION 'FALLO abono: cobranzas no debía poder abonar (mensaje: %)', v_msg;
  END IF;
END $$;

RESET ROLE;

-- ------------------------------------------------------------
-- Gerencia: abono sobre una cuota con un pago parcial activo → error
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0840c000-0000-4000-8000-000000000005', true),
       set_config('request.jwt.claims', '{"sub":"0840c000-0000-4000-8000-000000000005","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_msg text;
BEGIN
  BEGIN
    -- Cuota 1 tiene la parte de 200 (activa).
    PERFORM public.apply_prepayment('0840c000-0000-4000-8000-000000000101', 100, 'reducir_cuota',
      '[{"id":"0840c000-0000-4000-8000-000000000201","newAmount":400}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%pagos parciales%' THEN
    RAISE EXCEPTION 'FALLO abono con partes: debía rechazar (mensaje: %)', v_msg;
  END IF;
END $$;

RESET ROLE;

-- ------------------------------------------------------------
-- Ventas: no puede ponerse un área ni ver el libro de pagos
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0840c000-0000-4000-8000-000000000003', true),
       set_config('request.jwt.claims', '{"sub":"0840c000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_msg text;
  v_n   bigint;
  v_acc uuid := current_setting('t084.acc')::uuid;
BEGIN
  BEGIN
    UPDATE public.profiles SET area = 'cobranzas' WHERE user_id = auth.uid();
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%set_member_area%' THEN
    RAISE EXCEPTION 'FALLO área: un agente se cambió el área solo (mensaje: %)', v_msg;
  END IF;

  SELECT count(*) INTO v_n FROM public.installment_payments;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FALLO ventas: ve % pagos del libro (esperado 0)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.installments WHERE account_id = v_acc;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FALLO ventas: ve % cuotas (esperado 0)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.installment_schedule WHERE account_id = v_acc;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FALLO ventas: ve % cuotas del cronograma (esperado 0)', v_n;
  END IF;
  IF public.can_access_module(v_acc, 'cobranzas') OR NOT public.can_access_module(v_acc, 'ventas') THEN
    RAISE EXCEPTION 'FALLO ventas: can_access_module incorrecto';
  END IF;
  IF (public.my_module_access()->>'cobranzas')::boolean THEN
    RAISE EXCEPTION 'FALLO ventas: my_module_access dice que entra a cobranzas';
  END IF;

  v_msg := NULL;
  BEGIN
    PERFORM public.create_payment_plan(jsonb_build_object(
      'contact_id', '0840c000-0000-4000-8000-000000000301', 'total_amount', 100,
      'installments_count', 1, 'monthly_amount', 100, 'first_due_date', current_date,
      'installments', jsonb_build_array(jsonb_build_object('number', 1, 'amount', 100, 'due_date', current_date))));
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'FALLO ventas: pudo crear un plan';
  END IF;
END $$;

RESET ROLE;

-- ------------------------------------------------------------
-- Admin sin área: ser admin ya no abre Cobranzas
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0840c000-0000-4000-8000-000000000006', true),
       set_config('request.jwt.claims', '{"sub":"0840c000-0000-4000-8000-000000000006","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_n bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.installment_payments;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FALLO admin: ve % pagos del libro (esperado 0)', v_n;
  END IF;
  IF public.can_access_module(current_setting('t084.acc')::uuid, 'cobranzas') THEN
    RAISE EXCEPTION 'FALLO admin: can_access_module(cobranzas) debía ser false';
  END IF;
END $$;

RESET ROLE;

-- ------------------------------------------------------------
-- Legal: ve el cronograma pero no los pagos; crea planes
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0840c000-0000-4000-8000-000000000004', true),
       set_config('request.jwt.claims', '{"sub":"0840c000-0000-4000-8000-000000000004","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_n    bigint;
  v_plan uuid;
  v_t    jsonb;
BEGIN
  SELECT count(*) INTO v_n FROM public.installment_schedule WHERE plan_id = '0840c000-0000-4000-8000-000000000101';
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'FALLO legal: ve % cuotas del cronograma (esperado 3)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.installments;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FALLO legal: ve % filas de installments (esperado 0: tienen datos de pago)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.installment_payments;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FALLO legal: ve % pagos (esperado 0)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.payment_plan_balances;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FALLO legal: ve % saldos de planes (esperado 0)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.installment_balances;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FALLO legal: ve % saldos de cuotas (esperado 0)', v_n;
  END IF;
  IF (SELECT count(*) FROM public.payment_plans WHERE id = '0840c000-0000-4000-8000-000000000101') <> 1 THEN
    RAISE EXCEPTION 'FALLO legal: no ve el plan';
  END IF;

  v_plan := public.create_payment_plan(jsonb_build_object(
    'contact_id', '0840c000-0000-4000-8000-000000000301',
    'currency', 'PEN', 'total_amount', 1000, 'down_payment', 400,
    'installments_count', 2, 'monthly_amount', 300, 'due_day', 5,
    'first_due_date', current_date + 10,
    'installments', jsonb_build_array(
      jsonb_build_object('number', 1, 'amount', 300, 'due_date', current_date + 10),
      jsonb_build_object('number', 2, 'amount', 300, 'due_date', current_date + 40))));

  SELECT count(*) INTO v_n FROM public.installment_schedule WHERE plan_id = v_plan AND state = 'pendiente';
  SELECT collection_terms INTO v_t FROM public.payment_plans WHERE id = v_plan;
  IF v_n <> 2 OR v_t IS NULL OR (v_t->>'max_payment_parts')::int <> 3 OR v_t->>'late_fee_type' <> 'diaria' THEN
    RAISE EXCEPTION 'FALLO crear plan: cuotas=% términos=%', v_n, v_t;
  END IF;
END $$;

RESET ROLE;

-- ------------------------------------------------------------
-- Cobranzas: adelanto de las 2 últimas cuotas, cierre y reapertura del plan
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0840c000-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"0840c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_n    int;
  v_pay  uuid;
  v_st   text;
  v_bal  record;
  v_msg  text;
BEGIN
  -- Cuotas 1 y 3 dejan un hueco: no son las siguientes en orden ni las últimas.
  BEGIN
    PERFORM public.register_advance_payment('0840c000-0000-4000-8000-000000000101',
      ARRAY['0840c000-0000-4000-8000-000000000201', '0840c000-0000-4000-8000-000000000203']::uuid[],
      'efectivo', NULL, NULL, NULL);
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%orden%' THEN
    RAISE EXCEPTION 'FALLO adelanto: cuotas 1 y 3 debían rechazarse (mensaje: %)', v_msg;
  END IF;

  v_n := public.register_advance_payment('0840c000-0000-4000-8000-000000000101',
    ARRAY['0840c000-0000-4000-8000-000000000202', '0840c000-0000-4000-8000-000000000203']::uuid[],
    'efectivo', 'ADV-1', NULL, NULL);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'FALLO adelanto: pagó % cuotas (esperado 2)', v_n;
  END IF;

  v_pay := public.register_installment_payment(
    '0840c000-0000-4000-8000-000000000201', 300, 'efectivo', NULL, NULL, NULL);
  SELECT status INTO v_st FROM public.payment_plans WHERE id = '0840c000-0000-4000-8000-000000000101';
  IF v_st <> 'pagado' THEN
    RAISE EXCEPTION 'FALLO cierre: el plan quedó % (esperado pagado)', v_st;
  END IF;

  SELECT * INTO v_bal FROM public.payment_plan_balances WHERE plan_id = '0840c000-0000-4000-8000-000000000101';
  IF v_bal.paid_amount <> 1500 OR v_bal.pending_amount <> 0 OR v_bal.paid_count <> 3 OR v_bal.adelantada_count <> 0 THEN
    RAISE EXCEPTION 'FALLO saldos: paid=% pending=% paid_count=%', v_bal.paid_amount, v_bal.pending_amount, v_bal.paid_count;
  END IF;

  PERFORM public.void_installment_payment(v_pay, 'Prueba de reapertura');
  SELECT status INTO v_st FROM public.payment_plans WHERE id = '0840c000-0000-4000-8000-000000000101';
  IF v_st <> 'activo' THEN
    RAISE EXCEPTION 'FALLO reapertura: el plan quedó % (esperado activo)', v_st;
  END IF;

  SELECT * INTO v_bal FROM public.payment_plan_balances WHERE plan_id = '0840c000-0000-4000-8000-000000000101';
  IF v_bal.paid_amount <> 1200 OR v_bal.pending_amount <> 300 OR v_bal.pending_count <> 1 THEN
    RAISE EXCEPTION 'FALLO saldos tras anular: paid=% pending=% pending_count=%',
      v_bal.paid_amount, v_bal.pending_amount, v_bal.pending_count;
  END IF;

  -- Un pago no se borra.
  v_msg := NULL;
  BEGIN
    DELETE FROM public.installment_payments WHERE id = v_pay;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_msg := 'borró'; END IF;
  EXCEPTION WHEN OTHERS THEN v_msg := NULL;
  END;
  IF v_msg IS NOT NULL THEN
    RAISE EXCEPTION 'FALLO libro: authenticated pudo borrar un pago';
  END IF;
END $$;

-- ------------------------------------------------------------
-- Cobranzas: rechazar un voucher del cliente lo limpia con motivo
-- ------------------------------------------------------------
RESET ROLE;
UPDATE public.installments
   SET voucher_path = 'account-x/vouchers/c/v2.jpg', declared_amount = 300
 WHERE id = '0840c000-0000-4000-8000-000000000201';
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_i record;
BEGIN
  PERFORM public.reject_client_voucher('0840c000-0000-4000-8000-000000000201', 'Foto ilegible');
  SELECT * INTO v_i FROM public.installments WHERE id = '0840c000-0000-4000-8000-000000000201';
  IF v_i.voucher_path IS NOT NULL OR v_i.declared_amount IS NOT NULL
     OR v_i.voucher_rejection->>'reason' IS DISTINCT FROM 'Foto ilegible'
     OR v_i.voucher_rejection->>'path' IS DISTINCT FROM 'account-x/vouchers/c/v2.jpg' THEN
    RAISE EXCEPTION 'FALLO rechazo: % / % / %', v_i.voucher_path, v_i.declared_amount, v_i.voucher_rejection;
  END IF;
END $$;

RESET ROLE;

-- ------------------------------------------------------------
-- Dueño: acceso total
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0840c000-0000-4000-8000-000000000001', true),
       set_config('request.jwt.claims', '{"sub":"0840c000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_m jsonb := public.my_module_access();
BEGIN
  IF NOT ((v_m->>'cobranzas')::boolean AND (v_m->>'legal')::boolean
          AND (v_m->>'cronograma')::boolean AND (v_m->>'ventas')::boolean) THEN
    RAISE EXCEPTION 'FALLO dueño: my_module_access = %', v_m;
  END IF;
  IF (SELECT count(*) FROM public.installment_payments
       WHERE plan_id = '0840c000-0000-4000-8000-000000000101') <> 5 THEN
    RAISE EXCEPTION 'FALLO dueño: no ve los 5 pagos del plan (incluidos los anulados)';
  END IF;
END $$;

RESET ROLE;

-- ------------------------------------------------------------
-- Borrar un usuario de Auth que registró y anuló pagos: sus referencias
-- quedan en NULL (el trigger de inmutabilidad lo permite).
-- ------------------------------------------------------------
DO $$
DECLARE
  v_u  uuid := '0840c000-0000-4000-8000-000000000007';
  v_id uuid;
  v_p  record;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (v_u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          't084-borrar@example.test', '{}'::jsonb, now(), now());
  -- Su cuenta personal (la crea handle_new_user) sale primero.
  DELETE FROM public.accounts WHERE owner_user_id = v_u;

  INSERT INTO public.installment_payments
    (account_id, plan_id, installment_id, amount, paid_on, registered_by, voided_at, voided_by, void_reason)
  VALUES (current_setting('t084.acc')::uuid, '0840c000-0000-4000-8000-000000000101',
          '0840c000-0000-4000-8000-000000000202', 1, current_date, v_u, now(), v_u, 'Prueba de borrado')
  RETURNING id INTO v_id;

  DELETE FROM auth.users WHERE id = v_u;

  SELECT * INTO v_p FROM public.installment_payments WHERE id = v_id;
  IF NOT FOUND OR v_p.registered_by IS NOT NULL OR v_p.voided_by IS NOT NULL OR v_p.amount <> 1 THEN
    RAISE EXCEPTION 'FALLO borrar usuario: el pago no quedó con registered_by/voided_by en NULL';
  END IF;
END $$;

-- ------------------------------------------------------------
-- Borrados: un plan con pagos en una cuenta viva no se borra (ni sus
-- pagos, ni siquiera como postgres); la cuenta entera sí, con su libro.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_acc uuid := current_setting('t084.acc')::uuid;
  v_msg text;
BEGIN
  BEGIN
    DELETE FROM public.payment_plans WHERE id = '0840c000-0000-4000-8000-000000000101';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'FALLO borrar plan: un plan con pagos se borró';
  END IF;

  v_msg := NULL;
  BEGIN
    DELETE FROM public.installment_payments WHERE plan_id = '0840c000-0000-4000-8000-000000000101';
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%no se borra%' THEN
    RAISE EXCEPTION 'FALLO libro: postgres borró pagos de una cuenta viva (mensaje: %)', v_msg;
  END IF;

  DELETE FROM public.accounts WHERE id = v_acc;
  IF EXISTS (SELECT 1 FROM public.installment_payments WHERE account_id = v_acc) THEN
    RAISE EXCEPTION 'FALLO borrar cuenta: quedaron pagos';
  END IF;
END $$;

SELECT '084: todos los casos OK' AS resultado;

ROLLBACK;
