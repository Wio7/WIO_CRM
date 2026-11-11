-- ============================================================
-- 091_casos.sql — Casos de la migración 091 (invitación Promueve)
--
-- Cómo correrlo: DESPUÉS de aplicar 091 (y 089), pegar todo en el SQL Editor
-- de Supabase (corre como postgres). Cada caso es un DO que lanza
-- RAISE EXCEPTION 'FALLO ...' si algo no cuadra; si llega al final sin
-- error, imprime "091: todos los casos OK". Todo va dentro de una
-- transacción que termina en ROLLBACK: no deja datos.
--
-- Suplantación como en 089_casos.sql (set_config + SET LOCAL ROLE
-- authenticated; RESET ROLE vuelve a postgres). Prefijo de ids 0910c000-.
-- GUC: t091.acc.
--
-- Las filas que inserta solo usan columnas que existen en la base real y en
-- las migraciones del repo (la base real se desvía de las migraciones: se
-- valida contra el esquema OpenAPI, ver el encabezado de la 091).
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- Fixtures (como postgres)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_owner uuid := '0910c000-0000-4000-8000-000000000001';
  v_adm   uuid := '0910c000-0000-4000-8000-000000000002';  -- administrador de la cuenta
  v_ext   uuid := '0910c000-0000-4000-8000-000000000003';  -- futuro Promueve (cuenta personal vacía)
  v_ase   uuid := '0910c000-0000-4000-8000-000000000004';  -- futuro asesor normal (cuenta personal vacía)
  v_dat   uuid := '0910c000-0000-4000-8000-000000000005';  -- invitado con datos en su cuenta personal
  v_mem   uuid := '0910c000-0000-4000-8000-000000000006';  -- ya es miembro de la cuenta
  v_acc   uuid;
  v_pers  uuid;
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (v_owner, 't091-owner@example.test'), (v_adm, 't091-adm@example.test'),
      (v_ext, 't091-ext@example.test'), (v_ase, 't091-ase@example.test'),
      (v_dat, 't091-dat@example.test'), (v_mem, 't091-mem@example.test')
    ) AS u(id, email)
  LOOP
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES (r.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            r.email, jsonb_build_object('full_name', r.email), now(), now());
    -- En Supabase real, handle_new_user ya creó la cuenta personal.
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = r.id) THEN
      INSERT INTO public.accounts (name, owner_user_id) VALUES ('Personal ' || r.email, r.id) RETURNING id INTO v_pers;
      INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
      VALUES (r.id, r.email, r.email, v_pers, 'owner');
    END IF;
  END LOOP;

  -- La cuenta "de la empresa" es la personal del dueño.
  SELECT account_id INTO v_acc FROM public.profiles WHERE user_id = v_owner;
  UPDATE public.accounts SET status = 'active', name = 'Prueba 091' WHERE id = v_acc;

  -- Un administrador y un miembro ya dentro de la cuenta (su cuenta personal sobra).
  UPDATE public.profiles SET account_id = v_acc, account_role = 'admin' WHERE user_id = v_adm;
  UPDATE public.profiles SET account_id = v_acc, account_role = 'agent' WHERE user_id = v_mem;

  -- v_dat tiene un contacto en su cuenta personal: unirse la dejaría huérfana.
  INSERT INTO public.contacts (account_id, user_id, phone, name)
  SELECT account_id, v_dat, '+51999000091', 'Contacto 091' FROM public.profiles WHERE user_id = v_dat;

  PERFORM set_config('t091.acc', v_acc::text, true);
END $$;

-- ------------------------------------------------------------
-- 1. Restricción: el área solo vale 'promueve' y solo con rol agent
-- ------------------------------------------------------------
DO $$
DECLARE
  v_acc uuid := current_setting('t091.acc')::uuid;
  v_owner uuid := '0910c000-0000-4000-8000-000000000001';
BEGIN
  BEGIN
    INSERT INTO public.account_invitations (account_id, token_hash, role, area, created_by_user_id, expires_at)
    VALUES (v_acc, 't091-viewer', 'viewer', 'promueve', v_owner, now() + interval '7 days');
    RAISE EXCEPTION 'FALLO check: area promueve con rol viewer debía rechazarse';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.account_invitations (account_id, token_hash, role, area, created_by_user_id, expires_at)
    VALUES (v_acc, 't091-admin', 'admin', 'promueve', v_owner, now() + interval '7 days');
    RAISE EXCEPTION 'FALLO check: area promueve con rol admin debía rechazarse';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.account_invitations (account_id, token_hash, role, area, created_by_user_id, expires_at)
    VALUES (v_acc, 't091-otra', 'agent', 'legal', v_owner, now() + interval '7 days');
    RAISE EXCEPTION 'FALLO check: un área distinta de promueve debía rechazarse';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- Las válidas: Promueve (agent + promueve), asesor normal, y una para un
  -- usuario que ya es miembro, otra para el invitado con datos.
  INSERT INTO public.account_invitations (account_id, token_hash, role, area, created_by_user_id, expires_at, label)
  VALUES (v_acc, 't091-ext', 'agent', 'promueve', v_owner, now() + interval '7 days', 'Externo 091'),
         (v_acc, 't091-ase', 'agent', NULL,       v_owner, now() + interval '7 days', 'Asesor 091'),
         (v_acc, 't091-dat', 'agent', 'promueve', v_owner, now() + interval '7 days', 'Con datos 091'),
         (v_acc, 't091-mem', 'agent', 'promueve', v_owner, now() + interval '7 days', 'Ya miembro 091'),
         (v_acc, 't091-venc', 'agent', 'promueve', v_owner, now() - interval '1 day',  'Vencida 091');
END $$;

-- ------------------------------------------------------------
-- 2. peek_invitation devuelve el área (null cuando no hay)
-- ------------------------------------------------------------
DO $$
DECLARE
  v_p json;
BEGIN
  v_p := public.peek_invitation('t091-ext');
  IF NOT (v_p->>'ok')::boolean OR v_p->>'area' IS DISTINCT FROM 'promueve' OR v_p->>'role' <> 'agent' THEN
    RAISE EXCEPTION 'FALLO peek: la invitación Promueve debía traer role agent y area promueve, vino %', v_p;
  END IF;
  v_p := public.peek_invitation('t091-ase');
  IF NOT (v_p->>'ok')::boolean OR v_p->>'area' IS NOT NULL THEN
    RAISE EXCEPTION 'FALLO peek: la invitación normal no debía traer área, vino %', v_p;
  END IF;
  v_p := public.peek_invitation('t091-venc');
  IF (v_p->>'ok')::boolean OR v_p->>'reason' <> 'expired' THEN
    RAISE EXCEPTION 'FALLO peek: la vencida debía decir expired, vino %', v_p;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. Canje de la invitación Promueve (como el invitado, rol authenticated)
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0910c000-0000-4000-8000-000000000003', true),
       set_config('request.jwt.claims', '{"sub":"0910c000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_res uuid;
BEGIN
  v_res := public.redeem_invitation('t091-ext');
  IF v_res IS DISTINCT FROM current_setting('t091.acc')::uuid THEN
    RAISE EXCEPTION 'FALLO canje: debía devolver la cuenta de la invitación';
  END IF;
  -- Con el rol authenticated el perfil propio sigue visible (profiles_select: user_id = auth.uid()).
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND area = 'promueve') THEN
    RAISE EXCEPTION 'FALLO canje: el perfil debía quedar con area = promueve';
  END IF;
  -- El guard de 084 sigue en pie: el usuario no se quita el área por su cuenta.
  BEGIN
    UPDATE public.profiles SET area = NULL WHERE user_id = auth.uid();
    RAISE EXCEPTION 'FALLO guard: el Promueve se quitó el área';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
  BEGIN
    UPDATE public.profiles SET account_role = 'owner' WHERE user_id = auth.uid();
    RAISE EXCEPTION 'FALLO guard: el Promueve se subió el rol';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_acc uuid := current_setting('t091.acc')::uuid;
  v_ext uuid := '0910c000-0000-4000-8000-000000000003';
  p public.profiles%ROWTYPE;
BEGIN
  SELECT * INTO p FROM public.profiles WHERE user_id = v_ext;
  IF p.account_id <> v_acc OR p.account_role <> 'agent' OR p.area IS DISTINCT FROM 'promueve' OR p.area_set_at IS NULL THEN
    RAISE EXCEPTION 'FALLO canje: el perfil debía quedar agent/promueve en la cuenta (vino %, %, %)', p.account_role, p.area, p.account_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.account_invitations
                  WHERE token_hash = 't091-ext' AND accepted_at IS NOT NULL AND accepted_by_user_id = v_ext) THEN
    RAISE EXCEPTION 'FALLO canje: la invitación debía quedar aceptada por el invitado';
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounts WHERE owner_user_id = v_ext) THEN
    RAISE EXCEPTION 'FALLO canje: la cuenta personal huérfana debía borrarse';
  END IF;
END $$;

-- Ya con el área, no cuenta como miembro para las políticas (089).
SELECT set_config('request.jwt.claim.sub', '0910c000-0000-4000-8000-000000000003', true),
       set_config('request.jwt.claims', '{"sub":"0910c000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF public.is_account_member(current_setting('t091.acc')::uuid) THEN
    RAISE EXCEPTION 'FALLO rls: un Promueve recién canjeado no debía contar como miembro';
  END IF;
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- 4. Un enlace gastado no se canjea otra vez
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0910c000-0000-4000-8000-000000000004', true),
       set_config('request.jwt.claims', '{"sub":"0910c000-0000-4000-8000-000000000004","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.redeem_invitation('t091-ext');
    RAISE EXCEPTION 'FALLO canje: un enlace ya usado debía rechazarse';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  BEGIN
    PERFORM public.redeem_invitation('t091-venc');
    RAISE EXCEPTION 'FALLO canje: un enlace vencido debía rechazarse';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  BEGIN
    PERFORM public.redeem_invitation('t091-no-existe');
    RAISE EXCEPTION 'FALLO canje: un enlace inventado debía rechazarse';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  -- Y el intento fallido no movió nada.
  IF (SELECT area FROM public.profiles WHERE user_id = auth.uid()) IS NOT NULL THEN
    RAISE EXCEPTION 'FALLO canje: un canje fallido no debía dejar área';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 5. Una invitación normal sigue igual: rol de la invitación y SIN área
-- ------------------------------------------------------------
DO $$
BEGIN
  PERFORM public.redeem_invitation('t091-ase');
END $$;
RESET ROLE;

DO $$
DECLARE
  p public.profiles%ROWTYPE;
BEGIN
  SELECT * INTO p FROM public.profiles WHERE user_id = '0910c000-0000-4000-8000-000000000004';
  IF p.account_id <> current_setting('t091.acc')::uuid OR p.account_role <> 'agent' OR p.area IS NOT NULL THEN
    RAISE EXCEPTION 'FALLO canje normal: debía quedar agent sin área (vino %, %)', p.account_role, p.area;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 6. La invitación Promueve no le pone el área a quien ya tiene vida en el CRM
-- ------------------------------------------------------------
-- 6a. Un invitado con datos en su cuenta personal: se rechaza y no cambia nada.
SELECT set_config('request.jwt.claim.sub', '0910c000-0000-4000-8000-000000000005', true),
       set_config('request.jwt.claims', '{"sub":"0910c000-0000-4000-8000-000000000005","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.redeem_invitation('t091-dat');
    RAISE EXCEPTION 'FALLO datos: con datos en su cuenta el canje debía rechazarse';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL; END;
END $$;
RESET ROLE;

-- 6b. Alguien que ya es miembro de la cuenta: tampoco se le pone el área.
SELECT set_config('request.jwt.claim.sub', '0910c000-0000-4000-8000-000000000006', true),
       set_config('request.jwt.claims', '{"sub":"0910c000-0000-4000-8000-000000000006","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.redeem_invitation('t091-mem');
    RAISE EXCEPTION 'FALLO miembro: quien ya es miembro no debía canjear';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL; END;
END $$;
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.profiles
              WHERE user_id IN ('0910c000-0000-4000-8000-000000000005', '0910c000-0000-4000-8000-000000000006')
                AND area IS NOT NULL) THEN
    RAISE EXCEPTION 'FALLO area: ni el invitado con datos ni el miembro existente debían recibir el área';
  END IF;
  IF EXISTS (SELECT 1 FROM public.account_invitations
              WHERE token_hash IN ('t091-dat', 't091-mem') AND accepted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'FALLO area: las invitaciones rechazadas no debían quedar aceptadas';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 7. El área no se puede tocar por la API de la tabla (RLS de la propia invitación)
--    El administrador sí puede leerla, un Promueve no (no es miembro).
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '0910c000-0000-4000-8000-000000000003', true),
       set_config('request.jwt.claims', '{"sub":"0910c000-0000-4000-8000-000000000003","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.account_invitations) <> 0 THEN
    RAISE EXCEPTION 'FALLO rls: un Promueve no debía ver las invitaciones de la cuenta';
  END IF;
END $$;
RESET ROLE;

SELECT '091: todos los casos OK' AS resultado;

ROLLBACK;
