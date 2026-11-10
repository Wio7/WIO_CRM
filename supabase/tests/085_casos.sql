-- ============================================================
-- 085_casos.sql — Casos de la migración 085 (traspasos entre áreas)
--
-- Cómo correrlo: DESPUÉS de aplicar 085, pegar todo en el SQL Editor de
-- Supabase (corre como postgres). Cada caso es un DO que lanza
-- RAISE EXCEPTION 'FALLO ...' si algo no cuadra; si llega al final sin
-- error, imprime "085: todos los casos OK".
--
-- No deja datos: todo va dentro de una transacción que termina en
-- ROLLBACK (usuarios, cuenta, plan y traspasos de prueba desaparecen).
--
-- Suplantación como en 084_casos.sql: set_config de request.jwt.claims
-- (+ request.jwt.claim.sub) y SET LOCAL ROLE authenticated; RESET ROLE
-- vuelve a postgres.
--
-- IDs fijos (prefijo 0850c000-...); la cuenta de prueba va en el GUC
-- t085.acc y los traspasos creados en t085.legal, t085.pv_cobr y
-- t085.pv_legal.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- Fixtures (como postgres)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_owner     uuid := '0850c000-0000-4000-8000-000000000001';
  v_cobr      uuid := '0850c000-0000-4000-8000-000000000002';
  v_ventas    uuid := '0850c000-0000-4000-8000-000000000003';
  v_legal1    uuid := '0850c000-0000-4000-8000-000000000004';
  v_legal2    uuid := '0850c000-0000-4000-8000-000000000005';
  v_marketing uuid := '0850c000-0000-4000-8000-000000000006';
  v_postventa uuid := '0850c000-0000-4000-8000-000000000007';
  v_tecnico   uuid := '0850c000-0000-4000-8000-000000000008';
  v_legal3    uuid := '0850c000-0000-4000-8000-000000000009';  -- solo legal_members
  v_otro      uuid := '0850c000-0000-4000-8000-000000000010';  -- dueño de otra cuenta
  v_acc       uuid;
  v_otra      uuid;
  v_today     date := (now() AT TIME ZONE 'America/Lima')::date;
  r           record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (v_owner,     't085-owner@example.test'),
      (v_cobr,      't085-cobranzas@example.test'),
      (v_ventas,    't085-ventas@example.test'),
      (v_legal1,    't085-legal1@example.test'),
      (v_legal2,    't085-legal2@example.test'),
      (v_marketing, 't085-marketing@example.test'),
      (v_postventa, 't085-postventa@example.test'),
      (v_tecnico,   't085-tecnico@example.test'),
      (v_legal3,    't085-legal3@example.test'),
      (v_otro,      't085-otro@example.test')
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
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Prueba 085', v_owner) RETURNING id INTO v_acc;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_owner, 'Dueño 085', 't085-owner@example.test', v_acc, 'owner');
  END IF;
  UPDATE public.accounts SET status = 'active' WHERE id = v_acc;

  FOR r IN
    SELECT * FROM (VALUES
      (v_cobr,      'agent'::account_role_enum, 'cobranzas', 'Cobranzas 085'),
      (v_ventas,    'agent'::account_role_enum, 'ventas',    'Ventas 085'),
      (v_legal1,    'agent'::account_role_enum, 'legal',     'Legal Uno 085'),
      (v_legal2,    'agent'::account_role_enum, 'legal',     'Legal Dos 085'),
      (v_marketing, 'agent'::account_role_enum, 'marketing', 'Marketing 085'),
      (v_postventa, 'agent'::account_role_enum, 'ventas',    'Postventa 085'),
      (v_tecnico,   'agent'::account_role_enum, NULL,        'Técnico 085'),
      (v_legal3,    'agent'::account_role_enum, 'marketing', 'Legal Tres 085')
    ) AS m(id, role, area, full_name)
  LOOP
    UPDATE public.profiles SET account_id = v_acc, account_role = r.role, area = r.area, full_name = r.full_name
     WHERE user_id = r.id;
    IF NOT FOUND THEN
      INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, area)
      VALUES (r.id, r.full_name, r.id::text || '@example.test', v_acc, r.role, r.area);
    END IF;
  END LOOP;
  UPDATE public.profiles SET full_name = 'Dueño 085' WHERE user_id = v_owner;

  INSERT INTO public.contacts (id, account_id, user_id, phone, name)
  VALUES ('0850c000-0000-4000-8000-000000000301', v_acc, v_owner, '+51900085085', 'Cliente 085');

  INSERT INTO public.real_estate_projects (id, account_id, name)
  VALUES ('0850c000-0000-4000-8000-000000000401', v_acc, 'Proyecto 085');
  INSERT INTO public.real_estate_units (id, project_id, account_id, code, manzana)
  VALUES ('0850c000-0000-4000-8000-000000000501', '0850c000-0000-4000-8000-000000000401', v_acc, '12', 'A');

  INSERT INTO public.payment_plans (id, account_id, contact_id, unit_id, currency, total_amount, down_payment,
                                    installments_count, monthly_amount, due_day, first_due_date, status)
  VALUES ('0850c000-0000-4000-8000-000000000101', v_acc, '0850c000-0000-4000-8000-000000000301',
          '0850c000-0000-4000-8000-000000000501', 'PEN', 1500, 0, 3, 500, NULL, v_today - 40, 'activo');

  -- Dos cuotas vencidas y una por vencer: deuda 1500, 2 vencidas.
  INSERT INTO public.installments (id, plan_id, account_id, number, amount, due_date) VALUES
    ('0850c000-0000-4000-8000-000000000201', '0850c000-0000-4000-8000-000000000101', v_acc, 1, 500, v_today - 40),
    ('0850c000-0000-4000-8000-000000000202', '0850c000-0000-4000-8000-000000000101', v_acc, 2, 500, v_today - 10),
    ('0850c000-0000-4000-8000-000000000203', '0850c000-0000-4000-8000-000000000101', v_acc, 3, 500, v_today + 20);

  -- Una gestión previa (aparece en el resumen que ve legal).
  INSERT INTO public.collection_actions (account_id, contact_id, plan_id, channel, result, note, created_by)
  VALUES (v_acc, '0850c000-0000-4000-8000-000000000301', '0850c000-0000-4000-8000-000000000101',
          'llamada', 'no_contesta', 'Llamada sin respuesta', v_cobr);

  -- Otra cuenta con su propio cliente y plan (frontera entre cuentas).
  SELECT account_id INTO v_otra FROM public.profiles WHERE user_id = v_otro;
  IF v_otra IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Otra 085', v_otro) RETURNING id INTO v_otra;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_otro, 'Otro 085', 't085-otro@example.test', v_otra, 'owner');
  END IF;
  INSERT INTO public.contacts (id, account_id, user_id, phone, name)
  VALUES ('0850c000-0000-4000-8000-000000000302', v_otra, v_otro, '+51900085086', 'Cliente Otra 085');
  INSERT INTO public.payment_plans (id, account_id, contact_id, currency, total_amount, down_payment,
                                    installments_count, monthly_amount, due_day, first_due_date, status)
  VALUES ('0850c000-0000-4000-8000-000000000102', v_otra, '0850c000-0000-4000-8000-000000000302',
          'PEN', 900, 0, 3, 300, NULL, v_today - 40, 'activo');

  PERFORM set_config('t085.acc', v_acc::text, true);
END $$;

-- ------------------------------------------------------------
-- Cobranzas: pasa a legal dos veces (doble clic) → 1 traspaso y 1 gestión
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0850c000-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"0850c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_plan uuid := '0850c000-0000-4000-8000-000000000101';
  v_a    uuid;
  v_b    uuid;
  v_n    bigint;
  v_ca   record;
  v_row  jsonb;
BEGIN
  IF NOT public.handoff_destination_ready('pase_legal') THEN
    RAISE EXCEPTION 'FALLO destino: legal tiene dos personas y handoff_destination_ready dice false';
  END IF;
  -- Nadie tiene postventa (el dueño, con acceso total, no cuenta).
  IF public.handoff_destination_ready('postventa_desde_cobranzas') THEN
    RAISE EXCEPTION 'FALLO destino: sin filas de postventa debía ser false';
  END IF;

  v_a := public.send_handoff('pase_legal', v_plan, 'Cliente en causal', NULL);
  v_b := public.send_handoff('pase_legal', v_plan, 'Doble clic', NULL);
  IF v_a IS NULL OR v_a IS DISTINCT FROM v_b THEN
    RAISE EXCEPTION 'FALLO doble clic: dos envíos dieron % y % (esperado el mismo)', v_a, v_b;
  END IF;

  SELECT count(*) INTO v_n FROM public.module_handoffs
   WHERE kind = 'pase_legal' AND entity_id = v_plan AND status = 'pendiente';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FALLO doble clic: % traspasos pendientes (esperado 1)', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM public.collection_actions WHERE plan_id = v_plan AND result = 'pase_legal';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FALLO gestión: % gestiones pase_legal (esperado 1)', v_n;
  END IF;
  SELECT * INTO v_ca FROM public.collection_actions WHERE plan_id = v_plan AND result = 'pase_legal';
  IF v_ca.channel <> 'otro' OR v_ca.note IS DISTINCT FROM 'Cliente en causal'
     OR v_ca.contact_id <> '0850c000-0000-4000-8000-000000000301'
     OR v_ca.created_by IS DISTINCT FROM '0850c000-0000-4000-8000-000000000002'::uuid THEN
    RAISE EXCEPTION 'FALLO gestión: canal=% nota=% contacto=% autor=%', v_ca.channel, v_ca.note, v_ca.contact_id, v_ca.created_by;
  END IF;

  -- Enviados de cobranzas: el resumen lo arma el servidor.
  SELECT count(*) INTO v_n FROM public.my_handoffs('cobranzas', 'enviados');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FALLO enviados: % filas (esperado 1)', v_n;
  END IF;
  SELECT r INTO v_row FROM public.my_handoffs('cobranzas', 'enviados') r;
  IF v_row->>'kind' <> 'pase_legal' OR v_row->>'status' <> 'pendiente'
     OR v_row->>'sent_by_name' IS DISTINCT FROM 'Cobranzas 085'
     OR v_row->>'note' IS DISTINCT FROM 'Cliente en causal'
     OR (v_row->'summary'->>'deuda_total')::numeric <> 1500
     OR v_row->'summary'->>'moneda' IS DISTINCT FROM 'PEN'
     OR (v_row->'summary'->>'cuotas_vencidas')::int <> 2
     OR v_row->'summary'->>'cliente' IS DISTINCT FROM 'Cliente 085'
     OR v_row->'summary'->>'telefono' IS DISTINCT FROM '+51900085085'
     OR v_row->'summary'->>'plan_id' IS DISTINCT FROM '0850c000-0000-4000-8000-000000000101'
     OR v_row->'summary'->>'contact_id' IS DISTINCT FROM '0850c000-0000-4000-8000-000000000301'
     OR jsonb_array_length(v_row->'summary'->'gestiones') <> 2
     OR v_row->'summary'->'gestiones'->0->>'resultado' IS NULL THEN
    RAISE EXCEPTION 'FALLO resumen pase_legal: %', v_row;
  END IF;
  SELECT count(*) INTO v_n FROM public.my_handoffs('cobranzas', 'recibidos');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FALLO recibidos de cobranzas: % filas (esperado 0)', v_n;
  END IF;

  PERFORM set_config('t085.legal', v_a::text, true);
END $$;

-- ------------------------------------------------------------
-- Cobranzas: tema inválido, tipo desconocido y escritura directa → error
-- ------------------------------------------------------------
DO $$
DECLARE
  v_msg text;
  v_n   int;
BEGIN
  BEGIN
    PERFORM public.send_handoff('postventa_desde_cobranzas', '0850c000-0000-4000-8000-000000000301', NULL, 'xx');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%tema%' THEN
    RAISE EXCEPTION 'FALLO tema: debía rechazar el tema xx (mensaje: %)', v_msg;
  END IF;

  v_msg := NULL;
  BEGIN
    PERFORM public.send_handoff('postventa_desde_cobranzas', '0850c000-0000-4000-8000-000000000301', NULL, NULL);
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%tema%' THEN
    RAISE EXCEPTION 'FALLO tema: debía pedir el tema (mensaje: %)', v_msg;
  END IF;

  v_msg := NULL;
  BEGIN
    PERFORM public.send_handoff('pase_contabilidad', '0850c000-0000-4000-8000-000000000101', NULL, NULL);
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%desconocido%' THEN
    RAISE EXCEPTION 'FALLO tipo: debía rechazar un tipo desconocido (mensaje: %)', v_msg;
  END IF;

  -- La entidad tiene que ser del tipo que pide la conexión (un contacto no es un plan).
  v_msg := NULL;
  BEGIN
    PERFORM public.send_handoff('pase_legal', '0850c000-0000-4000-8000-000000000301', NULL, NULL);
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%no encontrado%' THEN
    RAISE EXCEPTION 'FALLO entidad: pase_legal con un contacto no falló (mensaje: %)', v_msg;
  END IF;

  -- Un plan o un cliente de OTRA cuenta se rechaza.
  v_msg := NULL;
  BEGIN
    PERFORM public.send_handoff('pase_legal', '0850c000-0000-4000-8000-000000000102', NULL, NULL);
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%no encontrado%' THEN
    RAISE EXCEPTION 'FALLO otra cuenta: pase_legal con un plan ajeno no falló (mensaje: %)', v_msg;
  END IF;

  v_msg := NULL;
  BEGIN
    PERFORM public.send_handoff('postventa_desde_cobranzas', '0850c000-0000-4000-8000-000000000302', NULL, 'entrega');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%no encontrado%' THEN
    RAISE EXCEPTION 'FALLO otra cuenta: postventa con un cliente ajeno no falló (mensaje: %)', v_msg;
  END IF;

  v_msg := NULL;
  BEGIN
    -- Fila válida (sin otro pendiente igual): el error tiene que venir del permiso.
    INSERT INTO public.module_handoffs (account_id, kind, from_module, to_module, entity_type, entity_id, topic)
    VALUES (current_setting('t085.acc')::uuid, 'postventa_desde_cobranzas', 'cobranzas', 'postventa', 'contact',
            '0850c000-0000-4000-8000-000000000301', 'otro');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'FALLO escritura: authenticated insertó un traspaso directo';
  END IF;

  v_msg := NULL;
  BEGIN
    UPDATE public.module_handoffs SET status = 'aceptado' WHERE id = current_setting('t085.legal')::uuid;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_msg := NULL; ELSE v_msg := 'sin filas'; END IF;
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'FALLO escritura: authenticated aceptó un traspaso con UPDATE directo';
  END IF;

  v_msg := NULL;
  BEGIN
    DELETE FROM public.module_handoffs WHERE id = current_setting('t085.legal')::uuid;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_msg := NULL; ELSE v_msg := 'sin filas'; END IF;
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'FALLO escritura: authenticated borró un traspaso';
  END IF;
END $$;

RESET ROLE;

-- ------------------------------------------------------------
-- Dueño: el área técnica a una persona; luego postventa a otra
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0850c000-0000-4000-8000-000000000001', true),
       set_config('request.jwt.claims', '{"sub":"0850c000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_acc uuid := current_setting('t085.acc')::uuid;
BEGIN
  -- El dueño entra a postventa por acceso total, pero no cuenta como "alguien en postventa".
  IF NOT public.can_access_module(v_acc, 'postventa') THEN
    RAISE EXCEPTION 'FALLO dueño: can_access_module(postventa) debía ser true';
  END IF;
  IF public.handoff_destination_ready('postventa_desde_cobranzas') THEN
    RAISE EXCEPTION 'FALLO destino: el dueño no debía contar como persona de postventa';
  END IF;

  PERFORM public.set_member_area('0850c000-0000-4000-8000-000000000008', 'tecnica');
END $$;

RESET ROLE;

-- Como postgres: comprobar el área y dar el módulo postventa (el CHECK de
-- account_module_members ya acepta 'postventa').
DO $$
BEGIN
  IF (SELECT area FROM public.profiles WHERE user_id = '0850c000-0000-4000-8000-000000000008') IS DISTINCT FROM 'tecnica' THEN
    RAISE EXCEPTION 'FALLO área: set_member_area no dejó tecnica';
  END IF;
  INSERT INTO public.account_module_members (account_id, user_id, module_key)
  VALUES (current_setting('t085.acc')::uuid, '0850c000-0000-4000-8000-000000000007', 'postventa');
  -- Los envíos con entidades de otra cuenta no dejaron nada.
  IF EXISTS (SELECT 1 FROM public.module_handoffs
              WHERE entity_id IN ('0850c000-0000-4000-8000-000000000102', '0850c000-0000-4000-8000-000000000302')) THEN
    RAISE EXCEPTION 'FALLO otra cuenta: quedó un traspaso con una entidad ajena';
  END IF;
END $$;

-- ------------------------------------------------------------
-- Cobranzas: ahora sí hay alguien en postventa → envía un caso
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0850c000-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"0850c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.handoff_destination_ready('postventa_desde_cobranzas') THEN
    RAISE EXCEPTION 'FALLO destino: con una persona en postventa debía ser true';
  END IF;
  IF public.can_access_module(current_setting('t085.acc')::uuid, 'postventa') THEN
    RAISE EXCEPTION 'FALLO cobranzas: no debía entrar a postventa';
  END IF;
  v_id := public.send_handoff('postventa_desde_cobranzas', '0850c000-0000-4000-8000-000000000301',
                              'Pregunta por la entrega', 'entrega');
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'FALLO postventa: send_handoff no devolvió id';
  END IF;
  PERFORM set_config('t085.pv_cobr', v_id::text, true);
END $$;

RESET ROLE;

-- ------------------------------------------------------------
-- Ventas y marketing: no ven traspasos ni el resumen con la deuda
-- ------------------------------------------------------------
DO $$
DECLARE
  r     record;
  v_n   bigint;
  v_msg text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('0850c000-0000-4000-8000-000000000003'::uuid, 'ventas'),
      ('0850c000-0000-4000-8000-000000000006'::uuid, 'marketing')) AS u(id, label)
  LOOP
    PERFORM set_config('request.jwt.claim.sub', r.id::text, true),
            set_config('request.jwt.claims', jsonb_build_object('sub', r.id, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;

    SELECT count(*) INTO v_n FROM public.module_handoffs;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'FALLO %: ve % traspasos (esperado 0)', r.label, v_n;
    END IF;
    SELECT count(*) INTO v_n FROM public.my_handoffs('legal', 'recibidos');
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'FALLO %: my_handoffs(legal, recibidos) dio % filas (esperado 0)', r.label, v_n;
    END IF;
    SELECT count(*) INTO v_n FROM public.my_handoffs('cobranzas', 'enviados');
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'FALLO %: my_handoffs(cobranzas, enviados) dio % filas (esperado 0)', r.label, v_n;
    END IF;
    SELECT count(*) INTO v_n FROM public.my_handoffs('postventa', 'recibidos');
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'FALLO %: my_handoffs(postventa, recibidos) dio % filas (esperado 0)', r.label, v_n;
    END IF;

    v_msg := NULL;
    BEGIN
      PERFORM public.send_handoff('pase_legal', '0850c000-0000-4000-8000-000000000101', NULL, NULL);
    EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
    END;
    IF v_msg IS NULL THEN
      RAISE EXCEPTION 'FALLO %: pudo pasar a legal sin el módulo cobranzas', r.label;
    END IF;

    v_msg := NULL;
    BEGIN
      PERFORM public.accept_handoff(current_setting('t085.legal')::uuid);
    EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
    END;
    IF v_msg IS NULL THEN
      RAISE EXCEPTION 'FALLO %: pudo aceptar un traspaso de legal', r.label;
    END IF;

    RESET ROLE;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- Legal Uno: ve el caso con la deuda, lo acepta y envía uno a postventa
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0850c000-0000-4000-8000-000000000004', true),
       set_config('request.jwt.claims', '{"sub":"0850c000-0000-4000-8000-000000000004","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_n   bigint;
  v_row jsonb;
  v_h   record;
  v_id  uuid;
BEGIN
  SELECT count(*) INTO v_n FROM public.my_handoffs('legal', 'recibidos');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FALLO legal: % recibidos (esperado 1)', v_n;
  END IF;
  SELECT r INTO v_row FROM public.my_handoffs('legal', 'recibidos') r;
  -- Legal no lee payment_plan_balances, pero el resumen del traspaso sí trae la deuda.
  IF (v_row->'summary'->>'deuda_total')::numeric <> 1500 OR (v_row->'summary'->>'cuotas_vencidas')::int <> 2 THEN
    RAISE EXCEPTION 'FALLO legal: resumen sin deuda (%)', v_row->'summary';
  END IF;
  SELECT count(*) INTO v_n FROM public.my_handoffs('legal', 'enviados');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FALLO legal: % enviados (esperado 0)', v_n;
  END IF;
  -- La fila: legal la ve (módulo destino); el caso de postventa de cobranzas, no.
  SELECT count(*) INTO v_n FROM public.module_handoffs;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'FALLO legal: ve % filas de module_handoffs (esperado 1)', v_n;
  END IF;

  PERFORM public.accept_handoff(current_setting('t085.legal')::uuid);
  SELECT * INTO v_h FROM public.module_handoffs WHERE id = current_setting('t085.legal')::uuid;
  IF v_h.status <> 'aceptado' OR v_h.handled_by IS DISTINCT FROM '0850c000-0000-4000-8000-000000000004'::uuid
     OR v_h.handled_at IS NULL THEN
    RAISE EXCEPTION 'FALLO aceptar: estado=% atendido_por=% fecha=%', v_h.status, v_h.handled_by, v_h.handled_at;
  END IF;

  v_id := public.send_handoff('postventa_desde_legal', '0850c000-0000-4000-8000-000000000301',
                              'Pide copia del contrato', 'documentos');
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'FALLO legal → postventa: send_handoff no devolvió id';
  END IF;
  PERFORM set_config('t085.pv_legal', v_id::text, true);
END $$;

RESET ROLE;

-- ------------------------------------------------------------
-- Legal Dos: acepta el mismo caso después → "Ya lo tomó Legal Uno"
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0850c000-0000-4000-8000-000000000005', true),
       set_config('request.jwt.claims', '{"sub":"0850c000-0000-4000-8000-000000000005","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_msg text;
BEGIN
  BEGIN
    PERFORM public.accept_handoff(current_setting('t085.legal')::uuid);
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%Ya lo tomó%' OR v_msg NOT ILIKE '%Legal Uno 085%' THEN
    RAISE EXCEPTION 'FALLO doble aceptación: mensaje %', v_msg;
  END IF;
END $$;

RESET ROLE;

-- ------------------------------------------------------------
-- Cobranzas: tras aceptarse, un nuevo pase a legal sí crea otro traspaso;
-- no puede aceptar casos de postventa
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0850c000-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"0850c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_id  uuid;
  v_n   bigint;
  v_msg text;
BEGIN
  v_id := public.send_handoff('pase_legal', '0850c000-0000-4000-8000-000000000101', 'Segundo pase', NULL);
  IF v_id IS NULL OR v_id = current_setting('t085.legal')::uuid THEN
    RAISE EXCEPTION 'FALLO segundo pase: debía crear un traspaso nuevo (id %)', v_id;
  END IF;
  SELECT count(*) INTO v_n FROM public.collection_actions
   WHERE plan_id = '0850c000-0000-4000-8000-000000000101' AND result = 'pase_legal';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'FALLO segundo pase: % gestiones pase_legal (esperado 2)', v_n;
  END IF;

  BEGIN
    PERFORM public.accept_handoff(current_setting('t085.pv_cobr')::uuid);
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'FALLO cobranzas: aceptó un caso de postventa sin el módulo';
  END IF;

  -- Devolver también exige el módulo destino (el origen no se lo devuelve a sí mismo).
  v_msg := NULL;
  BEGIN
    PERFORM public.return_handoff(current_setting('t085.pv_cobr')::uuid, 'Me lo devuelvo');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%no encontrado%' THEN
    RAISE EXCEPTION 'FALLO cobranzas: devolvió un caso de postventa sin el módulo (mensaje: %)', v_msg;
  END IF;
  IF (SELECT r->>'status' FROM public.my_handoffs('cobranzas', 'enviados') r
       WHERE r->>'id' = current_setting('t085.pv_cobr')) IS DISTINCT FROM 'pendiente' THEN
    RAISE EXCEPTION 'FALLO cobranzas: el caso de postventa ya no está pendiente tras un devolver rechazado';
  END IF;
END $$;

RESET ROLE;

-- ------------------------------------------------------------
-- Legal Tres: está solo en legal_members (Golden Legal), sin área ni
-- fila de módulo → ve los recibidos de legal y acepta. Si la tabla no
-- existe (BD sin Golden Legal), el caso se salta.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_acc  uuid := current_setting('t085.acc')::uuid;
  v_user uuid := '0850c000-0000-4000-8000-000000000009';
  v_n    bigint;
  v_id   uuid;
  v_h    record;
BEGIN
  IF to_regclass('public.legal_members') IS NULL THEN
    RAISE NOTICE '085: no existe legal_members; se salta el caso de Legal Tres';
    RETURN;
  END IF;
  EXECUTE 'INSERT INTO public.legal_members (account_id, user_id, role) VALUES ($1, $2, ''reviewer'')'
    USING v_acc, v_user;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true),
          set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  IF public.can_access_module(v_acc, 'legal') THEN
    RAISE EXCEPTION 'FALLO legal tres: can_access_module(legal) debía seguir en false';
  END IF;
  IF NOT public.handoff_has_module(v_acc, 'legal') THEN
    RAISE EXCEPTION 'FALLO legal tres: handoff_has_module(legal) debía ser true por legal_members';
  END IF;
  IF public.handoff_has_module(v_acc, 'cobranzas') THEN
    RAISE EXCEPTION 'FALLO legal tres: legal_members no abre cobranzas';
  END IF;
  -- El primer pase (aceptado) y el segundo (pendiente).
  SELECT count(*) INTO v_n FROM public.my_handoffs('legal', 'recibidos');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'FALLO legal tres: % recibidos (esperado 2)', v_n;
  END IF;
  SELECT (r->>'id')::uuid INTO v_id FROM public.my_handoffs('legal', 'recibidos') r
   WHERE r->>'status' = 'pendiente';
  PERFORM public.accept_handoff(v_id);
  SELECT * INTO v_h FROM public.module_handoffs WHERE id = v_id;
  IF v_h.status IS DISTINCT FROM 'aceptado'
     OR v_h.handled_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'FALLO legal tres: estado=% atendido_por=%', v_h.status, v_h.handled_by;
  END IF;
  RESET ROLE;

  -- Sin Legal Uno ni Dos en el área, legal_members basta para que
  -- cobranzas vea "hay alguien en Legal".
  UPDATE public.profiles SET area = 'marketing'
   WHERE user_id IN ('0850c000-0000-4000-8000-000000000004', '0850c000-0000-4000-8000-000000000005');
  PERFORM set_config('request.jwt.claim.sub', '0850c000-0000-4000-8000-000000000002', true),
          set_config('request.jwt.claims', '{"sub":"0850c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  IF NOT public.handoff_destination_ready('pase_legal') THEN
    RAISE EXCEPTION 'FALLO destino: solo con legal_members debía ser true';
  END IF;
  RESET ROLE;
  UPDATE public.profiles SET area = 'legal'
   WHERE user_id IN ('0850c000-0000-4000-8000-000000000004', '0850c000-0000-4000-8000-000000000005');
END $$;

-- ------------------------------------------------------------
-- Postventa: recibe dos casos con lote y proyecto; devolver exige motivo
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0850c000-0000-4000-8000-000000000007', true),
       set_config('request.jwt.claims', '{"sub":"0850c000-0000-4000-8000-000000000007","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_n   bigint;
  v_row jsonb;
  v_h   record;
  v_msg text;
BEGIN
  IF NOT public.can_access_module(current_setting('t085.acc')::uuid, 'postventa') THEN
    RAISE EXCEPTION 'FALLO postventa: can_access_module(postventa) debía ser true con la fila explícita';
  END IF;

  SELECT count(*) INTO v_n FROM public.my_handoffs('postventa', 'recibidos');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'FALLO postventa: % recibidos (esperado 2)', v_n;
  END IF;
  SELECT r INTO v_row FROM public.my_handoffs('postventa', 'recibidos') r
   WHERE r->>'id' = current_setting('t085.pv_legal');
  IF v_row->>'kind' <> 'postventa_desde_legal' OR v_row->>'topic' <> 'documentos'
     OR v_row->>'sent_by_name' IS DISTINCT FROM 'Legal Uno 085'
     OR v_row->'summary'->>'lote' IS DISTINCT FROM 'A-12'
     OR v_row->'summary'->>'proyecto' IS DISTINCT FROM 'Proyecto 085'
     OR v_row->'summary'->>'cliente' IS DISTINCT FROM 'Cliente 085'
     OR v_row->'summary'->>'telefono' IS DISTINCT FROM '+51900085085'
     OR v_row->'summary'->>'contact_id' IS DISTINCT FROM '0850c000-0000-4000-8000-000000000301'
     OR v_row->'summary' ? 'deuda_total' THEN
    RAISE EXCEPTION 'FALLO resumen postventa: %', v_row;
  END IF;
  -- Postventa no entra a legal.
  SELECT count(*) INTO v_n FROM public.my_handoffs('legal', 'recibidos');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FALLO postventa: ve % recibidos de legal (esperado 0)', v_n;
  END IF;

  BEGIN
    PERFORM public.return_handoff(current_setting('t085.pv_cobr')::uuid, '   ');
  EXCEPTION WHEN OTHERS THEN v_msg := SQLERRM;
  END;
  IF v_msg IS NULL OR v_msg NOT ILIKE '%motivo%' THEN
    RAISE EXCEPTION 'FALLO devolver: sin motivo debía fallar (mensaje: %)', v_msg;
  END IF;

  PERFORM public.return_handoff(current_setting('t085.pv_cobr')::uuid, 'Es un tema de cobranzas');
  SELECT * INTO v_h FROM public.module_handoffs WHERE id = current_setting('t085.pv_cobr')::uuid;
  IF v_h.status <> 'devuelto' OR v_h.return_reason IS DISTINCT FROM 'Es un tema de cobranzas'
     OR v_h.handled_by IS DISTINCT FROM '0850c000-0000-4000-8000-000000000007'::uuid THEN
    RAISE EXCEPTION 'FALLO devolver: estado=% motivo=% atendido_por=%', v_h.status, v_h.return_reason, v_h.handled_by;
  END IF;

  PERFORM public.accept_handoff(current_setting('t085.pv_legal')::uuid);
  IF (SELECT status FROM public.module_handoffs WHERE id = current_setting('t085.pv_legal')::uuid) <> 'aceptado' THEN
    RAISE EXCEPTION 'FALLO postventa: no quedó aceptado el caso de legal';
  END IF;
END $$;

RESET ROLE;

-- ------------------------------------------------------------
-- Cobranzas ve la devolución con su motivo en "Enviados"
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0850c000-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"0850c000-0000-4000-8000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_row jsonb;
BEGIN
  SELECT r INTO v_row FROM public.my_handoffs('cobranzas', 'enviados') r
   WHERE r->>'id' = current_setting('t085.pv_cobr');
  IF v_row IS NULL OR v_row->>'status' <> 'devuelto'
     OR v_row->>'return_reason' IS DISTINCT FROM 'Es un tema de cobranzas'
     OR v_row->>'handled_by_name' IS DISTINCT FROM 'Postventa 085'
     OR v_row->>'handled_at' IS NULL THEN
    RAISE EXCEPTION 'FALLO enviados: la devolución no se ve bien (%)', v_row;
  END IF;
END $$;

RESET ROLE;

SELECT '085: todos los casos OK' AS resultado;

ROLLBACK;
