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
-- ============================================================
-- Tarea 2: gerencia_cobranza
-- Fechas relativas al día de Lima para que corra igual cualquier día.
-- Datos como postgres (los guards de 084 frenan dinero a authenticated).
-- Cliente A: cuotas vencidas hace 95 y 10 días (S/ 300 c/u) + pago anulado de 150.
-- Cliente B: al día; su cuota del mes (S/ 300) se pagó hoy; otra a +20 días.
-- Cliente F: cuota de 150 vencida hace 45 días con pago parcial de 50 hace 40 días.
-- Plan en USD (cuenta como otra moneda). Proyecto 2 sin planes.
-- ============================================================
RESET ROLE;
DO $$
DECLARE
  v_acc uuid := current_setting('t097.acc')::uuid;
  v_owner uuid := '0970c000-0000-4000-8000-000000000001';
  v_today date := (now() AT TIME ZONE 'America/Lima')::date;
  v_p1 uuid := '0970c000-0000-4000-8000-000000000101';
  v_p2 uuid := '0970c000-0000-4000-8000-000000000102';
  v_u1 uuid := '0970c000-0000-4000-8000-000000000201';
  v_u2 uuid := '0970c000-0000-4000-8000-000000000202';
  v_ca uuid := '0970c000-0000-4000-8000-000000000301';
  v_cb uuid := '0970c000-0000-4000-8000-000000000302';
  v_cf uuid := '0970c000-0000-4000-8000-000000000303';
  v_pa uuid := '0970c000-0000-4000-8000-000000000401';
  v_pb uuid := '0970c000-0000-4000-8000-000000000402';
  v_pf uuid := '0970c000-0000-4000-8000-000000000403';
  v_pd uuid := '0970c000-0000-4000-8000-000000000404';
  v_a1 uuid := '0970c000-0000-4000-8000-000000000501';
  v_a2 uuid := '0970c000-0000-4000-8000-000000000502';
  v_b1 uuid := '0970c000-0000-4000-8000-000000000503';
  v_b2 uuid := '0970c000-0000-4000-8000-000000000504';
  v_f1 uuid := '0970c000-0000-4000-8000-000000000505';
  v_d1 uuid := '0970c000-0000-4000-8000-000000000506';
BEGIN
  INSERT INTO public.real_estate_projects (id, account_id, name) VALUES (v_p2, v_acc, 'Proyecto 2 097');
  INSERT INTO public.real_estate_units (id, project_id, account_id, code) VALUES (v_u1, v_p1, v_acc, 'A-01'), (v_u2, v_p1, v_acc, 'B-02');
  INSERT INTO public.contacts (id, user_id, account_id, phone, name) VALUES
    (v_ca, v_owner, v_acc, '+51900000001', 'Cliente A 097'),
    (v_cb, v_owner, v_acc, '+51900000002', 'Cliente B 097'),
    (v_cf, v_owner, v_acc, '+51900000003', 'Cliente F 097');
  INSERT INTO public.payment_plans (id, account_id, contact_id, unit_id, currency, total_amount, installments_count, monthly_amount, first_due_date) VALUES
    (v_pa, v_acc, v_ca, v_u1, 'PEN', 600, 2, 300, v_today - 95),
    (v_pb, v_acc, v_cb, v_u2, 'PEN', 600, 2, 300, date_trunc('month', v_today)::date),
    (v_pf, v_acc, v_cf, NULL, 'PEN', 150, 1, 150, v_today - 45),
    (v_pd, v_acc, v_cb, NULL, 'USD', 500, 1, 500, v_today + 5);
  INSERT INTO public.installments (id, plan_id, account_id, number, amount, due_date, status) VALUES
    (v_a1, v_pa, v_acc, 1, 300, v_today - 95, 'pendiente'),
    (v_a2, v_pa, v_acc, 2, 300, v_today - 10, 'pendiente'),
    (v_b1, v_pb, v_acc, 1, 300, date_trunc('month', v_today)::date, 'pendiente'),
    (v_b2, v_pb, v_acc, 2, 300, v_today + 20, 'pendiente'),
    (v_f1, v_pf, v_acc, 1, 150, v_today - 45, 'pendiente'),
    (v_d1, v_pd, v_acc, 1, 500, v_today + 5, 'pendiente');
  -- B paga su cuota del mes hoy (completa: queda pagada).
  INSERT INTO public.installment_payments (account_id, plan_id, installment_id, amount, paid_on)
  VALUES (v_acc, v_pb, v_b1, 300, v_today);
  UPDATE public.installments SET status = 'pagada', paid_at = now(), paid_amount = 300 WHERE id = v_b1;
  -- Pago de 150 anulado hoy sobre la cuota de A: no cuenta.
  INSERT INTO public.installment_payments (account_id, plan_id, installment_id, amount, paid_on, voided_at, void_reason)
  VALUES (v_acc, v_pa, v_a2, 150, v_today, now(), 'error de captura');
  -- Pago parcial de F hace 40 días (otro mes): da el último pago.
  INSERT INTO public.installment_payments (account_id, plan_id, installment_id, amount, paid_on)
  VALUES (v_acc, v_pf, v_f1, 50, v_today - 40);
END $$;

SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Lima')::date;
  v_p1 uuid := '0970c000-0000-4000-8000-000000000101';
  v_p2 uuid := '0970c000-0000-4000-8000-000000000102';
  v_exp_vencia bigint; v_exp_rem bigint;
  c jsonb; m jsonb; t jsonb; v_st text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0970c000-0000-4000-8000-000000000002', true);
  c := public.gerencia_cobranza();
  IF c->>'month' IS DISTINCT FROM date_trunc('month', v_today)::date::text THEN RAISE EXCEPTION 'FALLO: month por defecto, %', c; END IF;
  IF jsonb_array_length(c->'projects') IS DISTINCT FROM 2
     OR c->'projects'->0->>'name' IS DISTINCT FROM 'Proyecto 097'
     OR c->'projects'->1->>'name' IS DISTINCT FROM 'Proyecto 2 097' THEN RAISE EXCEPTION 'FALLO: projects, %', c->'projects'; END IF;

  -- Cartera: A 600 + B 300 + F 100 pendientes (USD aparte); vencida 600 + 100.
  IF (c#>>'{cartera,totalCents}')::bigint IS DISTINCT FROM 100000 THEN RAISE EXCEPTION 'FALLO: cartera total, %', c->'cartera'; END IF;
  IF (c#>>'{cartera,vencidaCents}')::bigint IS DISTINCT FROM 70000 THEN RAISE EXCEPTION 'FALLO: cartera vencida, %', c->'cartera'; END IF;
  IF (c#>>'{cartera,vigenteCents}')::bigint IS DISTINCT FROM 30000 THEN RAISE EXCEPTION 'FALLO: cartera vigente, %', c->'cartera'; END IF;
  IF (c#>>'{cartera,planes}')::int IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'FALLO: planes PEN, %', c->'cartera'; END IF;
  IF (c->>'otrasMonedas')::int IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'FALLO: otrasMonedas, %', c->'otrasMonedas'; END IF;

  -- Tramos: siempre 4, en orden; A (95 días) entera en +90, F (45 días) en 31-60.
  t := c->'tramos';
  IF jsonb_array_length(t) IS DISTINCT FROM 4
     OR t->0->>'tramo' IS DISTINCT FROM '1-30' OR t->1->>'tramo' IS DISTINCT FROM '31-60'
     OR t->2->>'tramo' IS DISTINCT FROM '61-90' OR t->3->>'tramo' IS DISTINCT FROM '+90' THEN RAISE EXCEPTION 'FALLO: tramos, %', t; END IF;
  IF (t->3->>'cents')::bigint IS DISTINCT FROM 60000 OR (t->3->>'clientes')::int IS DISTINCT FROM 1
     OR (t->1->>'cents')::bigint IS DISTINCT FROM 10000 OR (t->1->>'clientes')::int IS DISTINCT FROM 1
     OR (t->0->>'cents')::bigint IS DISTINCT FROM 0 OR (t->2->>'cents')::bigint IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FALLO: montos por tramo, %', t; END IF;

  -- Morosos: A (95 d, +90, sin pagos válidos) y F (45 d, último pago hace 40 d).
  IF jsonb_array_length(c->'morosos') IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'FALLO: morosos, %', c->'morosos'; END IF;
  m := c->'morosos'->0;
  IF m->>'name' IS DISTINCT FROM 'Cliente A 097' OR (m->>'diasAtraso')::int IS DISTINCT FROM 95 OR m->>'tramo' IS DISTINCT FROM '+90'
     OR (m->>'vencidoCents')::bigint IS DISTINCT FROM 60000 OR m->>'unit' IS DISTINCT FROM 'A-01'
     OR m->>'projectName' IS DISTINCT FROM 'Proyecto 097' OR m->>'phone' IS DISTINCT FROM '+51900000001'
     OR m->'ultimoPago' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'FALLO: moroso A, %', m; END IF;
  m := c->'morosos'->1;
  IF m->>'name' IS DISTINCT FROM 'Cliente F 097' OR (m->>'diasAtraso')::int IS DISTINCT FROM 45 OR m->>'tramo' IS DISTINCT FROM '31-60'
     OR (m->>'vencidoCents')::bigint IS DISTINCT FROM 10000 OR m->'unit' IS DISTINCT FROM 'null'::jsonb
     OR m->>'ultimoPago' IS DISTINCT FROM (v_today - 40)::text THEN RAISE EXCEPTION 'FALLO: moroso F, %', m; END IF;

  -- Mes: el pago anulado (150) no cuenta; solo los 300 de B.
  IF (c#>>'{mes,cobradoTotalCents}')::bigint IS DISTINCT FROM 30000 THEN RAISE EXCEPTION 'FALLO: cobradoTotal debe excluir el anulado, %', c->'mes'; END IF;
  IF c->'porDia' IS DISTINCT FROM jsonb_build_array(jsonb_build_object('dia', v_today::text, 'cents', 30000)) THEN
    RAISE EXCEPTION 'FALLO: porDia, %', c->'porDia'; END IF;
  -- Lo que vencía en el mes, calculado aparte (cuotas no condonadas con vencimiento en el mes).
  SELECT COALESCE(round(SUM(i.amount) * 100), 0)::bigint, COALESCE(round(SUM(b.remaining) * 100), 0)::bigint
    INTO v_exp_vencia, v_exp_rem
    FROM public.installments i JOIN public.installment_balances b ON b.installment_id = i.id
   WHERE i.account_id = current_setting('t097.acc')::uuid AND i.status <> 'condonada'
     AND i.due_date >= date_trunc('month', v_today)::date AND i.due_date < (date_trunc('month', v_today) + interval '1 month')::date
     AND i.plan_id IN (SELECT id FROM public.payment_plans WHERE currency = 'PEN');
  IF (c#>>'{mes,venciaCents}')::bigint IS DISTINCT FROM v_exp_vencia OR v_exp_vencia < 30000 THEN RAISE EXCEPTION 'FALLO: venciaCents % vs %', c->'mes', v_exp_vencia; END IF;
  IF (c#>>'{mes,cobradoDeLoQueVenciaCents}')::bigint IS DISTINCT FROM (v_exp_vencia - v_exp_rem) THEN RAISE EXCEPTION 'FALLO: cobradoDeLoQueVencia %', c->'mes'; END IF;
  IF (c#>>'{mes,recaudacionPct}')::numeric IS DISTINCT FROM round(100.0 * (v_exp_vencia - v_exp_rem) / v_exp_vencia, 1) THEN RAISE EXCEPTION 'FALLO: recaudacionPct %', c->'mes'; END IF;

  -- Meta: sin meta -> null; con 60000 y cobrado 30000 -> 50.0.
  PERFORM public.gerencia_set_goal(v_today, NULL, 'cobranza', 0);
  c := public.gerencia_cobranza();
  IF c#>'{mes,metaCents}' IS DISTINCT FROM 'null'::jsonb OR c#>'{mes,cumplimientoPct}' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'FALLO: sin meta debe dar null, %', c->'mes'; END IF;
  PERFORM public.gerencia_set_goal(v_today, NULL, 'cobranza', 60000);
  c := public.gerencia_cobranza(v_today);
  IF (c#>>'{mes,metaCents}')::bigint IS DISTINCT FROM 60000 OR (c#>>'{mes,cumplimientoPct}')::numeric IS DISTINCT FROM 50.0 THEN
    RAISE EXCEPTION 'FALLO: cumplimiento con meta, %', c->'mes'; END IF;

  -- Filtro por proyecto: P1 ve lo de P1 (sin F ni USD, que no tienen unidad); P2 no tiene nada.
  c := public.gerencia_cobranza(v_today, v_p1);
  IF c->>'projectId' IS DISTINCT FROM v_p1::text OR (c#>>'{cartera,totalCents}')::bigint IS DISTINCT FROM 90000
     OR (c#>>'{cartera,planes}')::int IS DISTINCT FROM 2 OR jsonb_array_length(c->'morosos') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FALLO: filtro por P1, %', c; END IF;
  IF c#>'{mes,metaCents}' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'FALLO: la meta total no aplica a un proyecto, %', c->'mes'; END IF;
  PERFORM public.gerencia_set_goal(v_today, v_p1, 'cobranza', 30000);
  IF (public.gerencia_cobranza(v_today, v_p1)#>>'{mes,cumplimientoPct}')::numeric IS DISTINCT FROM 100.0 THEN RAISE EXCEPTION 'FALLO: meta del proyecto'; END IF;
  c := public.gerencia_cobranza(v_today, v_p2);
  IF (c#>>'{cartera,totalCents}')::bigint IS DISTINCT FROM 0 OR jsonb_array_length(c->'morosos') IS DISTINCT FROM 0
     OR jsonb_array_length(c->'tramos') IS DISTINCT FROM 4 OR c#>'{mes,recaudacionPct}' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'FALLO: proyecto vacío, %', c; END IF;

  -- Proyecto de otra cuenta -> 22023.
  BEGIN PERFORM public.gerencia_cobranza(v_today, '0970c000-0000-4000-8000-000000000109'); EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '22023' THEN RAISE EXCEPTION 'FALLO: proyecto ajeno debía dar 22023 (%)', v_st; END IF;

  -- Cuenta vacía (la otra): ceros, nada de null en totales.
  PERFORM set_config('request.jwt.claim.sub', '0970c000-0000-4000-8000-000000000012', true);
  c := public.gerencia_cobranza();
  IF (c#>>'{cartera,totalCents}')::bigint IS DISTINCT FROM 0 OR (c#>>'{cartera,vencidaCents}')::bigint IS DISTINCT FROM 0
     OR (c#>>'{cartera,planes}')::int IS DISTINCT FROM 0 OR (c#>>'{mes,cobradoTotalCents}')::bigint IS DISTINCT FROM 0
     OR (c#>>'{mes,venciaCents}')::bigint IS DISTINCT FROM 0 OR c#>'{mes,recaudacionPct}' IS DISTINCT FROM 'null'::jsonb
     OR c->'porDia' IS DISTINCT FROM '[]'::jsonb OR c->'morosos' IS DISTINCT FROM '[]'::jsonb
     OR jsonb_array_length(c->'tramos') IS DISTINCT FROM 4 OR (c->>'otrasMonedas')::int IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FALLO: cuenta vacía, %', c; END IF;
  IF c->'projects'->0->>'name' IS DISTINCT FROM 'Proyecto ajeno 097' OR jsonb_array_length(c->'projects') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FALLO: projects de la otra cuenta, %', c->'projects'; END IF;

  -- Cobranzas no entra.
  PERFORM set_config('request.jwt.claim.sub', '0970c000-0000-4000-8000-000000000003', true);
  v_st := NULL;
  BEGIN PERFORM public.gerencia_cobranza(); EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'FALLO: cobranzas debía dar 42501 (%)', v_st; END IF;
END $$;
RESET ROLE;

SELECT '097: todos los casos OK' AS resultado;
ROLLBACK;
