-- ============================================================
-- 096_casos.sql — Casos de la migración 096 (app de Marketing)
--
-- Cómo correrlo: DESPUÉS de aplicar 096, pegar todo en el SQL Editor de
-- Supabase (corre como postgres). Cada caso lanza RAISE EXCEPTION 'FALLO ...'
-- si algo no cuadra; si llega al final imprime "096: todos los casos OK".
-- Todo va dentro de una transacción que termina en ROLLBACK: no deja datos.
-- Prefijo de ids 0960c000-. GUC: t096.acc.
--
-- Qué demuestra: el jefe ve resumen y leads; el equipo no, pero crea piezas y
-- tareas; el equipo no aprueba ni pasa a aprobada; el jefe aprueba y el equipo
-- publica; un área ajena (cobranzas) no ve nada; el gasto del resumen cuenta
-- el gasto de marketing vigente y no el anulado.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_owner uuid := '0960c000-0000-4000-8000-000000000001';
  v_jefe  uuid := '0960c000-0000-4000-8000-000000000002';  -- marketing + fila 'jefe'
  v_eq    uuid := '0960c000-0000-4000-8000-000000000003';  -- área marketing, sin fila
  v_cob   uuid := '0960c000-0000-4000-8000-000000000004';  -- cobranzas
  v_acc   uuid;
  v_p1    uuid := '0960c000-0000-4000-8000-000000000101';
  v_u1    uuid := '0960c000-0000-4000-8000-000000000201';
  v_c1    uuid := '0960c000-0000-4000-8000-000000000301';
  v_c2    uuid := '0960c000-0000-4000-8000-000000000302';
  v_c3    uuid := '0960c000-0000-4000-8000-000000000303';
  v_old   uuid := '0960c000-0000-4000-8000-000000000304';
  v_res   uuid := '0960c000-0000-4000-8000-000000000401';
  v_today date := (now() AT TIME ZONE 'America/Lima')::date;
  r       record;
BEGIN
  FOR r IN SELECT * FROM (VALUES (v_owner, 't096-owner@example.test'), (v_jefe, 't096-jefe@example.test'),
                                 (v_eq, 't096-eq@example.test'), (v_cob, 't096-cob@example.test')) AS u(id, email)
  LOOP
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES (r.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            r.email, jsonb_build_object('full_name', r.email), now(), now());
  END LOOP;

  SELECT account_id INTO v_acc FROM public.profiles WHERE user_id = v_owner;
  IF v_acc IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Prueba 096', v_owner) RETURNING id INTO v_acc;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_owner, 'Dueño 096', 't096-owner@example.test', v_acc, 'owner');
  END IF;
  UPDATE public.accounts SET status = 'active' WHERE id = v_acc;
  PERFORM set_config('t096.acc', v_acc::text, true);

  FOR r IN SELECT * FROM (VALUES (v_jefe, 'marketing', 'Carlos 096'), (v_eq, 'marketing', 'Mirella 096'),
                                 (v_cob, 'cobranzas', 'Cobranzas 096')) AS m(id, area, full_name)
  LOOP
    UPDATE public.profiles SET account_id = v_acc, account_role = 'agent', area = r.area, full_name = r.full_name
     WHERE user_id = r.id;
    IF NOT FOUND THEN
      INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role, area)
      VALUES (r.id, r.full_name, r.id::text || '@example.test', v_acc, 'agent', r.area);
    END IF;
  END LOOP;
  INSERT INTO public.marketing_members (account_id, user_id, role) VALUES (v_acc, v_jefe, 'jefe');

  -- Proyecto, unidad, contactos (3 de este mes, 1 de hace 2 meses) y una separación del contacto 1.
  INSERT INTO public.real_estate_projects (id, account_id, name) VALUES (v_p1, v_acc, 'Proyecto 096');
  INSERT INTO public.real_estate_units (id, account_id, project_id, code) VALUES (v_u1, v_acc, v_p1, 'A-1');
  INSERT INTO public.contacts (id, account_id, user_id, phone, name, created_at, lead_source, campaign_name, ad_id, utm_campaign)
  VALUES (v_c1, v_acc, v_owner, '+51900000001', 'Lead Uno', now(), 'meta_ads', 'Campaña 096', 'ad-1', 'utm-1'),
         (v_c2, v_acc, v_owner, '+51900000002', 'Lead Dos', now(), 'meta_ads', NULL, NULL, NULL),
         (v_c3, v_acc, v_owner, '+51900000003', 'Lead Tres', now(), NULL, NULL, NULL, NULL),
         (v_old, v_acc, v_owner, '+51900000004', 'Lead Viejo', now() - interval '65 days', 'web', NULL, NULL, NULL);
  INSERT INTO public.reservations (id, account_id, contact_id, status) VALUES (v_res, v_acc, v_c1, 'aprobada');
  INSERT INTO public.reservation_units (reservation_id, unit_id) VALUES (v_res, v_u1);
  -- conversations.user_id y broadcasts.template_name son NOT NULL en la base real (001).
  INSERT INTO public.conversations (id, user_id, account_id, contact_id, assigned_agent_id, created_at)
  VALUES ('0960c000-0000-4000-8000-000000000501', v_owner, v_acc, v_c1, v_eq, now());
  INSERT INTO public.broadcasts (id, user_id, account_id, name, template_name, status, total_recipients, read_count, replied_count)
  VALUES ('0960c000-0000-4000-8000-000000000601', v_owner, v_acc, 'Difusión 096', 'plantilla_096', 'sent', 100, 60, 10);

  -- Caja: gasto de marketing vigente 10.00 (proyecto), gasto de marketing 5.00 que se anula,
  -- gasto de obra 7.00 (no es marketing).
  INSERT INTO public.cash_companies (id, account_id, name, created_by)
  VALUES (v_acc, v_acc, 'Principal 096', v_owner) ON CONFLICT (id) DO NOTHING;
  PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
  PERFORM set_config('cash.rubro', 'marketing', true);
  PERFORM set_config('cash.project_id', v_p1::text, true);
  INSERT INTO public.cash_entries (id, account_id, company_id, request_id, kind, amount_cents, concept,
                                   counterparty, occurred_on, created_by, actor_name)
  VALUES ('0960c000-0000-4000-8000-000000000701', v_acc, v_acc, gen_random_uuid(), 'expense', 1000,
          'Anuncio 096', 'Meta', v_today, v_owner, 'Dueño 096');
  PERFORM set_config('cash.rubro', 'marketing', true);
  INSERT INTO public.cash_entries (id, account_id, company_id, request_id, kind, amount_cents, concept,
                                   counterparty, occurred_on, created_by, actor_name)
  VALUES ('0960c000-0000-4000-8000-000000000702', v_acc, v_acc, gen_random_uuid(), 'expense', 500,
          'Anuncio anulado 096', 'Meta', v_today, v_owner, 'Dueño 096');
  INSERT INTO public.cash_entries (account_id, company_id, request_id, kind, amount_cents, concept,
                                   counterparty, occurred_on, reversal_of, created_by, actor_name)
  VALUES (v_acc, v_acc, gen_random_uuid(), 'income', 500, 'Anulación 096', 'Meta', v_today,
          '0960c000-0000-4000-8000-000000000702', v_owner, 'Dueño 096');
  PERFORM set_config('cash.rubro', 'obra', true);
  INSERT INTO public.cash_entries (id, account_id, company_id, request_id, kind, amount_cents, concept,
                                   counterparty, occurred_on, created_by, actor_name)
  VALUES ('0960c000-0000-4000-8000-000000000703', v_acc, v_acc, gen_random_uuid(), 'expense', 700,
          'Obra 096', 'Ferretería', v_today, v_owner, 'Dueño 096');
  -- Gasto de marketing en la caja de otro negocio del dueño: NO cuenta.
  INSERT INTO public.cash_companies (id, account_id, name, created_by)
  VALUES ('0960c000-0000-4000-8000-000000000990', v_acc, 'Otro negocio 096', v_owner);
  PERFORM set_config('cash.rubro', 'marketing', true);
  INSERT INTO public.cash_entries (id, account_id, company_id, request_id, kind, amount_cents, concept,
                                   counterparty, occurred_on, created_by, actor_name)
  VALUES ('0960c000-0000-4000-8000-000000000704', v_acc, '0960c000-0000-4000-8000-000000000990', gen_random_uuid(),
          'expense', 9000, 'Publicidad de otro negocio 096', 'Meta', v_today, v_owner, 'Dueño 096');
END $$;

SET LOCAL ROLE authenticated;

-- 1. marketing_my_access devuelve el rol correcto
DO $$
DECLARE v jsonb; v_acc uuid := current_setting('t096.acc')::uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000002', true);
  v := public.marketing_my_access();
  IF v->>'role' <> 'jefe' OR (v->>'accountId')::uuid <> v_acc THEN
    RAISE EXCEPTION 'FALLO my_access jefe: %', v; END IF;
  IF jsonb_array_length(v->'projects') <> 1 THEN RAISE EXCEPTION 'FALLO: el jefe debe ver 1 proyecto, %', v->'projects'; END IF;
  -- Equipo marketing sin fila + jefe + dueño (jefe por is_owner_or_gerencia) = 3; cobranzas no entra.
  IF jsonb_array_length(v->'team') <> 3 THEN RAISE EXCEPTION 'FALLO team: %', v->'team'; END IF;

  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000003', true);
  v := public.marketing_my_access();
  IF v->>'role' <> 'equipo' THEN RAISE EXCEPTION 'FALLO my_access equipo: %', v; END IF;

  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000004', true);
  v := public.marketing_my_access();
  IF v->'role' <> 'null'::jsonb OR jsonb_array_length(v->'team') <> 0 OR jsonb_array_length(v->'projects') <> 0 THEN
    RAISE EXCEPTION 'FALLO my_access cobranzas: %', v; END IF;

  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000001', true);
  IF public.marketing_my_access()->>'role' <> 'jefe' THEN RAISE EXCEPTION 'FALLO: el dueño debe ser jefe'; END IF;
END $$;

-- 2. El jefe ve resumen y leads; el gasto cuenta el vigente y no el anulado ni el de obra
DO $$
DECLARE v jsonb; l jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000002', true);
  v := public.marketing_summary(NULL, NULL);
  IF (v->>'leadsTotal')::int <> 3 THEN RAISE EXCEPTION 'FALLO leadsTotal: % (esperado 3)', v->>'leadsTotal'; END IF;
  IF (v->>'spendCents')::bigint <> 1000 THEN
    RAISE EXCEPTION 'FALLO gasto: % (esperado 1000: vigente sí, anulado y obra no)', v->>'spendCents'; END IF;
  IF (v->>'separaciones')::int <> 1 THEN RAISE EXCEPTION 'FALLO separaciones: %', v->>'separaciones'; END IF;
  IF (v->>'costPerLeadCents')::bigint <> 333 OR (v->>'costPerSeparacionCents')::bigint <> 1000 THEN
    RAISE EXCEPTION 'FALLO costos: % / %', v->>'costPerLeadCents', v->>'costPerSeparacionCents'; END IF;
  IF v->>'month' <> to_char((now() AT TIME ZONE 'America/Lima')::date, 'YYYY-MM') THEN
    RAISE EXCEPTION 'FALLO mes: %', v->>'month'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'leadsByChannel') c
                  WHERE c->>'channel' = 'meta_ads' AND (c->>'count')::int = 2)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'leadsByChannel') c WHERE c->>'channel' = 'sin_origen') THEN
    RAISE EXCEPTION 'FALLO canales: %', v->'leadsByChannel'; END IF;
  IF jsonb_array_length(v->'byMonth') <> 12 THEN RAISE EXCEPTION 'FALLO byMonth'; END IF;
  IF (v->'broadcasts'->0->>'total')::int <> 100 OR (v->'broadcasts'->0->>'read')::int <> 60 THEN
    RAISE EXCEPTION 'FALLO difusiones: %', v->'broadcasts'; END IF;
  -- Con el proyecto: el gasto y la separación siguen; los leads no se filtran,
  -- así que el costo por lead no se calcula (sería engañoso).
  v := public.marketing_summary(NULL, '0960c000-0000-4000-8000-000000000101');
  IF (v->>'spendCents')::bigint <> 1000 OR (v->>'separaciones')::int <> 1 OR (v->>'leadsTotal')::int <> 3 THEN
    RAISE EXCEPTION 'FALLO filtro de proyecto: %', v; END IF;
  IF v->'costPerLeadCents' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'FALLO: costo por lead con filtro de proyecto debe ser null (%)', v->'costPerLeadCents'; END IF;

  l := public.marketing_leads(NULL, NULL);
  IF jsonb_array_length(l) <> 4 THEN RAISE EXCEPTION 'FALLO leads sin mes: % (esperado 4)', jsonb_array_length(l); END IF;
  l := public.marketing_leads((now() AT TIME ZONE 'America/Lima')::date, NULL);
  IF jsonb_array_length(l) <> 3 THEN RAISE EXCEPTION 'FALLO leads del mes: %', jsonb_array_length(l); END IF;
  SELECT x INTO l FROM jsonb_array_elements(l) x WHERE x->>'name' = 'Lead Uno';
  IF l->>'channel' <> 'meta_ads' OR l->>'campaign' <> 'Campaña 096' OR l->>'adId' <> 'ad-1'
     OR (l->>'separated')::boolean IS NOT TRUE OR l->>'projectName' <> 'Proyecto 096'
     OR l->>'advisorName' <> 'Mirella 096' OR l->>'phone' <> '+51900000001' THEN
    RAISE EXCEPTION 'FALLO lead uno: %', l; END IF;
  IF jsonb_array_length(public.marketing_leads(NULL, '0960c000-0000-4000-8000-000000000101')) <> 1 THEN
    RAISE EXCEPTION 'FALLO: el filtro de proyecto de leads debe devolver el que separó'; END IF;
END $$;

-- 3. El equipo no ve resumen ni leads
DO $$
DECLARE v_msg text; v_st text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000003', true);
  BEGIN PERFORM public.marketing_summary(NULL, NULL);
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; v_msg := SQLERRM; END;
  IF v_st IS DISTINCT FROM '42501' OR v_msg NOT LIKE '%Solo el jefe de marketing%' THEN
    RAISE EXCEPTION 'FALLO: el equipo vio el resumen (%, %)', v_st, v_msg; END IF;
  v_st := NULL;
  BEGIN PERFORM public.marketing_leads(NULL, NULL);
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'FALLO: el equipo vio los leads (%)', v_st; END IF;
END $$;

-- 4. El equipo crea una pieza (y su tarea) y una tarea suelta; no aprueba
DO $$
DECLARE v_acc uuid := current_setting('t096.acc')::uuid; v_st text; t record; n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000003', true);
  INSERT INTO public.marketing_pieces (id, account_id, title, network, format, scheduled_on, assignee)
  VALUES ('0960c000-0000-4000-8000-000000000801', v_acc, 'Reel del lanzamiento', 'instagram', 'reel',
          CURRENT_DATE + 3, '0960c000-0000-4000-8000-000000000003');
  SELECT * INTO t FROM public.marketing_tasks WHERE piece_id = '0960c000-0000-4000-8000-000000000801';
  IF t.id IS NULL OR t.kind <> 'pieza' OR t.title <> 'Reel del lanzamiento' OR t.status <> 'por_hacer'
     OR t.due_on <> CURRENT_DATE + 3 OR t.assignee <> '0960c000-0000-4000-8000-000000000003' THEN
    RAISE EXCEPTION 'FALLO: la pieza no creó su tarea (%)', t; END IF;
  INSERT INTO public.marketing_tasks (account_id, title, kind) VALUES (v_acc, 'Grabar recorrido', 'grabar');
  SELECT count(*) INTO n FROM public.marketing_tasks;
  IF n <> 2 THEN RAISE EXCEPTION 'FALLO: el equipo ve % tareas (esperado 2)', n; END IF;

  -- No crea piezas ya aprobadas.
  BEGIN
    INSERT INTO public.marketing_pieces (account_id, title, network, scheduled_on, status)
    VALUES (v_acc, 'Trampa', 'tiktok', CURRENT_DATE, 'aprobada');
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'FALLO: el equipo creó una pieza aprobada (%)', v_st; END IF;

  -- Puede pasar a en_revision, pero no a aprobada ni devuelta, ni publicar sin aprobar.
  UPDATE public.marketing_pieces SET status = 'en_revision' WHERE id = '0960c000-0000-4000-8000-000000000801';
  v_st := NULL;
  BEGIN UPDATE public.marketing_pieces SET status = 'aprobada' WHERE id = '0960c000-0000-4000-8000-000000000801';
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'FALLO: el equipo aprobó por UPDATE (%)', v_st; END IF;
  v_st := NULL;
  BEGIN UPDATE public.marketing_pieces SET status = 'devuelta' WHERE id = '0960c000-0000-4000-8000-000000000801';
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'FALLO: el equipo devolvió por UPDATE (%)', v_st; END IF;
  v_st := NULL;
  BEGIN UPDATE public.marketing_pieces SET status = 'publicada' WHERE id = '0960c000-0000-4000-8000-000000000801';
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '22023' THEN RAISE EXCEPTION 'FALLO: el equipo publicó sin aprobar (%)', v_st; END IF;
  v_st := NULL;
  BEGIN PERFORM public.marketing_review_piece('0960c000-0000-4000-8000-000000000801', true, NULL);
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'FALLO: el equipo aprobó con la función (%)', v_st; END IF;
END $$;

-- 5. El jefe devuelve (nota obligatoria), aprueba; el equipo publica y su tarea queda 'listo'
DO $$
DECLARE v_st text; p record; t record;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000002', true);
  BEGIN PERFORM public.marketing_review_piece('0960c000-0000-4000-8000-000000000801', false, '  ');
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '22023' THEN RAISE EXCEPTION 'FALLO: devolvió sin nota (%)', v_st; END IF;
  PERFORM public.marketing_review_piece('0960c000-0000-4000-8000-000000000801', false, 'Cambiar la portada');
  SELECT * INTO p FROM public.marketing_pieces WHERE id = '0960c000-0000-4000-8000-000000000801';
  IF p.status <> 'devuelta' OR p.review_note <> 'Cambiar la portada'
     OR p.reviewed_by <> '0960c000-0000-4000-8000-000000000002' THEN RAISE EXCEPTION 'FALLO devolver: %', p; END IF;
  PERFORM public.marketing_review_piece('0960c000-0000-4000-8000-000000000801', true, 'Listo');
  SELECT * INTO p FROM public.marketing_pieces WHERE id = '0960c000-0000-4000-8000-000000000801';
  IF p.status <> 'aprobada' THEN RAISE EXCEPTION 'FALLO aprobar: %', p.status; END IF;

  -- Si el equipo cambia el texto de una pieza aprobada, vuelve a revisión.
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000003', true);
  UPDATE public.marketing_pieces SET caption = 'Texto cambiado después de aprobar' WHERE id = '0960c000-0000-4000-8000-000000000801';
  SELECT * INTO p FROM public.marketing_pieces WHERE id = '0960c000-0000-4000-8000-000000000801';
  IF p.status <> 'en_revision' THEN RAISE EXCEPTION 'FALLO: pieza aprobada cambiada quedó %', p.status; END IF;
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000002', true);
  PERFORM public.marketing_review_piece('0960c000-0000-4000-8000-000000000801', true, 'Listo de nuevo');

  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000003', true);
  UPDATE public.marketing_pieces SET status = 'publicada' WHERE id = '0960c000-0000-4000-8000-000000000801';
  SELECT * INTO p FROM public.marketing_pieces WHERE id = '0960c000-0000-4000-8000-000000000801';
  IF p.status <> 'publicada' OR p.published_at IS NULL THEN RAISE EXCEPTION 'FALLO publicar: %', p; END IF;
  SELECT * INTO t FROM public.marketing_tasks WHERE piece_id = '0960c000-0000-4000-8000-000000000801';
  IF t.status <> 'listo' THEN RAISE EXCEPTION 'FALLO: la tarea de la pieza publicada quedó %', t.status; END IF;

  -- El equipo no puede borrar una pieza ajena ni reabrir una publicada.
  DELETE FROM public.marketing_pieces WHERE id = '0960c000-0000-4000-8000-000000000801';
  IF NOT EXISTS (SELECT 1 FROM public.marketing_pieces WHERE id = '0960c000-0000-4000-8000-000000000801') THEN
    RAISE EXCEPTION 'FALLO: el equipo borró una pieza publicada'; END IF;
  v_st := NULL;
  BEGIN UPDATE public.marketing_pieces SET status = 'borrador' WHERE id = '0960c000-0000-4000-8000-000000000801';
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'FALLO: el equipo reabrió una publicada (%)', v_st; END IF;
  -- Tampoco cambia el contenido de una pieza publicada.
  v_st := NULL;
  BEGIN UPDATE public.marketing_pieces SET caption = 'Cambio después de publicar' WHERE id = '0960c000-0000-4000-8000-000000000801';
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'FALLO: el equipo cambió una pieza publicada (%)', v_st; END IF;
END $$;

-- 5b. Publicar con contenido nuevo en el mismo UPDATE vuelve a revisión; published_at no se falsifica;
--     created_by no se cambia ni se inventa; una pieza creada ya publicada deja su tarea en 'listo'.
DO $$
DECLARE v_acc uuid := current_setting('t096.acc')::uuid; p record; t record; v_task uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000002', true);
  INSERT INTO public.marketing_pieces (id, account_id, title, network, scheduled_on, assignee)
  VALUES ('0960c000-0000-4000-8000-000000000803', v_acc, 'Post de feria', 'facebook', CURRENT_DATE + 5,
          '0960c000-0000-4000-8000-000000000003');
  PERFORM public.marketing_review_piece('0960c000-0000-4000-8000-000000000803', true, NULL);

  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000003', true);
  UPDATE public.marketing_pieces SET status = 'publicada', caption = 'Texto que el jefe no vio'
   WHERE id = '0960c000-0000-4000-8000-000000000803';
  SELECT * INTO p FROM public.marketing_pieces WHERE id = '0960c000-0000-4000-8000-000000000803';
  IF p.status <> 'en_revision' THEN RAISE EXCEPTION 'FALLO: se publicó contenido no aprobado (%)', p.status; END IF;

  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000002', true);
  PERFORM public.marketing_review_piece('0960c000-0000-4000-8000-000000000803', true, NULL);
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000003', true);
  UPDATE public.marketing_pieces SET status = 'publicada', published_at = '2020-01-01'
   WHERE id = '0960c000-0000-4000-8000-000000000803';
  SELECT * INTO p FROM public.marketing_pieces WHERE id = '0960c000-0000-4000-8000-000000000803';
  IF p.status <> 'publicada' OR p.published_at < now() - interval '1 day' THEN
    RAISE EXCEPTION 'FALLO: published_at falsificado (%)', p.published_at; END IF;

  -- created_by: el equipo no se apropia de una tarea del jefe para borrarla, ni firma como otro.
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000002', true);
  INSERT INTO public.marketing_tasks (account_id, title) VALUES (v_acc, 'Tarea del jefe') RETURNING id INTO v_task;
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000003', true);
  UPDATE public.marketing_tasks SET created_by = '0960c000-0000-4000-8000-000000000003' WHERE id = v_task;
  DELETE FROM public.marketing_tasks WHERE id = v_task;
  SELECT * INTO t FROM public.marketing_tasks WHERE id = v_task;
  IF t.id IS NULL OR t.created_by <> '0960c000-0000-4000-8000-000000000002' THEN
    RAISE EXCEPTION 'FALLO: el equipo se apropió de la tarea del jefe (%)', t; END IF;
  INSERT INTO public.marketing_tasks (account_id, title, created_by)
  VALUES (v_acc, 'Firmada como otro', '0960c000-0000-4000-8000-000000000002') RETURNING id INTO v_task;
  SELECT * INTO t FROM public.marketing_tasks WHERE id = v_task;
  IF t.created_by <> '0960c000-0000-4000-8000-000000000003' THEN
    RAISE EXCEPTION 'FALLO: tarea creada a nombre de otro (%)', t.created_by; END IF;

  -- El jefe crea una pieza ya publicada: su tarea queda 'listo'.
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000002', true);
  INSERT INTO public.marketing_pieces (id, account_id, title, network, scheduled_on, status)
  VALUES ('0960c000-0000-4000-8000-000000000805', v_acc, 'Estado ya publicado', 'whatsapp', CURRENT_DATE, 'publicada');
  SELECT * INTO t FROM public.marketing_tasks WHERE piece_id = '0960c000-0000-4000-8000-000000000805';
  IF t.status <> 'listo' THEN RAISE EXCEPTION 'FALLO: tarea de pieza publicada quedó %', t.status; END IF;
END $$;

-- 6. Cobranzas no ve piezas ni tareas, no crea, no llama resumen ni leads ni revisión
DO $$
DECLARE v_st text; n int; v_acc uuid := current_setting('t096.acc')::uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000004', true);
  SELECT count(*) INTO n FROM public.marketing_pieces;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLO: cobranzas ve % piezas', n; END IF;
  SELECT count(*) INTO n FROM public.marketing_tasks;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLO: cobranzas ve % tareas', n; END IF;
  SELECT count(*) INTO n FROM public.marketing_members;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLO: cobranzas ve % miembros', n; END IF;
  BEGIN INSERT INTO public.marketing_pieces (account_id, title, network, scheduled_on)
        VALUES (v_acc, 'No', 'instagram', CURRENT_DATE);
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'FALLO: cobranzas creó una pieza (%)', v_st; END IF;
  v_st := NULL;
  BEGIN PERFORM public.marketing_summary(NULL, NULL);
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'FALLO: cobranzas llamó el resumen (%)', v_st; END IF;
  v_st := NULL;
  BEGIN PERFORM public.marketing_leads(NULL, NULL);
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'FALLO: cobranzas llamó los leads (%)', v_st; END IF;
  v_st := NULL;
  BEGIN PERFORM public.marketing_review_piece('0960c000-0000-4000-8000-000000000801', true, NULL);
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS NULL THEN RAISE EXCEPTION 'FALLO: cobranzas revisó una pieza'; END IF;
END $$;

-- 7. Miembros: el equipo no se agrega; el dueño sí
DO $$
DECLARE v_st text; v_acc uuid := current_setting('t096.acc')::uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000003', true);
  BEGIN INSERT INTO public.marketing_members (account_id, user_id, role)
        VALUES (v_acc, '0960c000-0000-4000-8000-000000000003', 'jefe');
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'FALLO: el equipo se hizo jefe (%)', v_st; END IF;
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000001', true);
  INSERT INTO public.marketing_members (account_id, user_id, role)
  VALUES (v_acc, '0960c000-0000-4000-8000-000000000003', 'equipo');
  IF public.marketing_my_access()->>'role' <> 'jefe' THEN RAISE EXCEPTION 'FALLO: el dueño perdió el rol'; END IF;
END $$;

-- 8. Storage: el equipo sube a la carpeta de su cuenta; cobranzas no
DO $$
DECLARE v_st text; v_acc uuid := current_setting('t096.acc')::uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'marketing' AND public = false AND file_size_limit = 52428800) THEN
    RAISE EXCEPTION 'FALLO: falta el bucket privado marketing'; END IF;
  -- El equipo sube el archivo de un borrador suyo.
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000003', true);
  INSERT INTO public.marketing_pieces (id, account_id, title, network, scheduled_on)
  VALUES ('0960c000-0000-4000-8000-000000000804', v_acc, 'Borrador con foto', 'instagram', CURRENT_DATE + 7);
  INSERT INTO storage.objects (bucket_id, name)
  VALUES ('marketing', v_acc::text || '/0960c000-0000-4000-8000-000000000804/foto.png');
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE name = v_acc::text || '/0960c000-0000-4000-8000-000000000804/foto.png') THEN
    RAISE EXCEPTION 'FALLO: el equipo no ve el archivo que subió'; END IF;
  -- No sube en una carpeta que no es una pieza.
  BEGIN INSERT INTO storage.objects (bucket_id, name) VALUES ('marketing', v_acc::text || '/pieza-1/foto.png');
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS NULL THEN RAISE EXCEPTION 'FALLO: el equipo subió fuera de una pieza'; END IF;
  -- No cambia el archivo de una pieza aprobada o publicada (la 803 está publicada).
  v_st := NULL;
  BEGIN INSERT INTO storage.objects (bucket_id, name)
        VALUES ('marketing', v_acc::text || '/0960c000-0000-4000-8000-000000000803/nueva.png');
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS NULL THEN RAISE EXCEPTION 'FALLO: el equipo cambió el archivo de una pieza publicada'; END IF;
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000002', true);
  INSERT INTO storage.objects (bucket_id, name)
  VALUES ('marketing', v_acc::text || '/0960c000-0000-4000-8000-000000000803/final.png');
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000003', true);
  DELETE FROM storage.objects WHERE name = v_acc::text || '/0960c000-0000-4000-8000-000000000803/final.png';
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000002', true);
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE name = v_acc::text || '/0960c000-0000-4000-8000-000000000803/final.png') THEN
    RAISE EXCEPTION 'FALLO: el equipo borró el archivo de una pieza publicada'; END IF;

  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000004', true);
  IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'marketing') THEN
    RAISE EXCEPTION 'FALLO: cobranzas ve archivos de marketing'; END IF;
  v_st := NULL;
  BEGIN INSERT INTO storage.objects (bucket_id, name)
        VALUES ('marketing', v_acc::text || '/0960c000-0000-4000-8000-000000000804/otra.png');
  EXCEPTION WHEN OTHERS THEN v_st := SQLSTATE; END;
  IF v_st IS NULL THEN RAISE EXCEPTION 'FALLO: cobranzas subió a marketing'; END IF;
END $$;

-- 9. Una cuenta suspendida no da rol de marketing al equipo.
RESET ROLE;
UPDATE public.accounts SET status = 'suspended' WHERE id = current_setting('t096.acc')::uuid;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '0960c000-0000-4000-8000-000000000003', true);
  IF public.marketing_my_access()->'role' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'FALLO: el equipo conserva el rol con la cuenta suspendida'; END IF;
END $$;
RESET ROLE;

SELECT '096: todos los casos OK' AS resultado;
ROLLBACK;
