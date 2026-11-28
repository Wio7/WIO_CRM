-- ============================================================
-- 300_casos.sql — Casos de la migración 300 (App DULMO)
--
-- Cómo correrlo: DESPUÉS de aplicar 300, pegar todo en el SQL Editor de
-- Supabase (corre como postgres). Cada caso lanza RAISE EXCEPTION 'FALLO ...'
-- si algo no cuadra; si llega al final imprime "300: todos los casos OK".
-- Todo va dentro de una transacción que termina en ROLLBACK: no deja datos.
-- Prefijo de ids 3000c000-. GUC: t300.dulmo, t300.otra.
--
-- Qué demuestra: la dueña de una cuenta con 'App DULMO' entra, crea y lee sus
-- proyectos, mediciones y ajustes; el dueño de otra cuenta (sin la app) no ve
-- ni escribe nada de DULMO, ni siquiera poniendo el account_id de DULMO; una
-- cuenta sin la app no tiene acceso aunque tenga filas; anon no tiene permisos.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_moni  uuid := '3000c000-0000-4000-8000-000000000001';
  v_otro  uuid := '3000c000-0000-4000-8000-000000000002';
  v_dulmo uuid;
  v_otra  uuid;
  r       record;
BEGIN
  FOR r IN SELECT * FROM (VALUES (v_moni, 't300-moni@example.test'), (v_otro, 't300-otro@example.test')) AS u(id, email)
  LOOP
    INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    VALUES (r.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            r.email, jsonb_build_object('full_name', r.email), now(), now());
  END LOOP;

  SELECT account_id INTO v_dulmo FROM public.profiles WHERE user_id = v_moni;
  IF v_dulmo IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('DULMO 300', v_moni) RETURNING id INTO v_dulmo;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_moni, 'Moni 300', 't300-moni@example.test', v_dulmo, 'owner');
  END IF;
  SELECT account_id INTO v_otra FROM public.profiles WHERE user_id = v_otro;
  IF v_otra IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('Otra 300', v_otro) RETURNING id INTO v_otra;
    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (v_otro, 'Otro 300', 't300-otro@example.test', v_otra, 'owner');
  END IF;

  UPDATE public.accounts SET status = 'active', apps = ARRAY['App DULMO'], brand_name = 'DULMO' WHERE id = v_dulmo;
  UPDATE public.accounts SET status = 'active', apps = ARRAY[]::text[] WHERE id = v_otra;
  -- Una fila en la cuenta sin app (puesta como postgres) para probar que no se ve.
  INSERT INTO public.dulmo_proyectos (account_id, cliente_nombre) VALUES (v_otra, 'Fila ajena');

  PERFORM set_config('t300.dulmo', v_dulmo::text, true);
  PERFORM set_config('t300.otra',  v_otra::text,  true);
END $$;

SET LOCAL ROLE authenticated;

-- Caso 1: Moni entra y ve su cuenta
DO $$
DECLARE v record;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '3000c000-0000-4000-8000-000000000001', true);
  SELECT * INTO v FROM public.dulmo_my_access();
  IF v.account_id IS DISTINCT FROM current_setting('t300.dulmo')::uuid THEN
    RAISE EXCEPTION 'FALLO 1: dulmo_my_access no devolvió la cuenta de Moni';
  END IF;
  IF v.brand_name <> 'DULMO' THEN RAISE EXCEPTION 'FALLO 1b: marca %', v.brand_name; END IF;
END $$;

-- Caso 2: Moni crea proyecto, medición y ajustes y los lee
DO $$
DECLARE v_acc uuid := current_setting('t300.dulmo')::uuid; v_p uuid; n int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '3000c000-0000-4000-8000-000000000001', true);
  INSERT INTO public.dulmo_proyectos (account_id, cliente_nombre, distrito)
  VALUES (v_acc, 'Cliente prueba', 'Ica') RETURNING id INTO v_p;
  INSERT INTO public.dulmo_mediciones (account_id, proyecto_id, cliente_nombre, fecha)
  VALUES (v_acc, v_p, 'Cliente prueba', now() + interval '1 day');
  INSERT INTO public.dulmo_ajustes (account_id, datos) VALUES (v_acc, '{"ganancia":0.4}')
  ON CONFLICT (account_id) DO UPDATE SET datos = EXCLUDED.datos;
  SELECT count(*) INTO n FROM public.dulmo_proyectos;
  IF n <> 1 THEN RAISE EXCEPTION 'FALLO 2: Moni ve % proyectos (esperado 1, sin la fila ajena)', n; END IF;
  SELECT count(*) INTO n FROM public.dulmo_mediciones;
  IF n <> 1 THEN RAISE EXCEPTION 'FALLO 2b: Moni ve % mediciones', n; END IF;
  UPDATE public.dulmo_proyectos SET estado = 'cotizado' WHERE id = v_p;
  IF NOT FOUND THEN RAISE EXCEPTION 'FALLO 2c: Moni no pudo actualizar su proyecto'; END IF;
END $$;

-- Caso 3: el dueño de otra cuenta no ve nada ni tiene acceso
DO $$
DECLARE n int; v record;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '3000c000-0000-4000-8000-000000000002', true);
  SELECT * INTO v FROM public.dulmo_my_access();
  IF v.account_id IS NOT NULL THEN RAISE EXCEPTION 'FALLO 3: la otra cuenta tiene acceso'; END IF;
  SELECT count(*) INTO n FROM public.dulmo_proyectos;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLO 3b: la otra cuenta ve % proyectos', n; END IF;
  SELECT count(*) INTO n FROM public.dulmo_mediciones;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLO 3c: la otra cuenta ve % mediciones', n; END IF;
  SELECT count(*) INTO n FROM public.dulmo_ajustes;
  IF n <> 0 THEN RAISE EXCEPTION 'FALLO 3d: la otra cuenta ve ajustes'; END IF;
END $$;

-- Caso 4: la otra cuenta no puede escribir en DULMO ni en la suya (sin app)
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '3000c000-0000-4000-8000-000000000002', true);
  BEGIN
    INSERT INTO public.dulmo_proyectos (account_id, cliente_nombre)
    VALUES (current_setting('t300.dulmo')::uuid, 'intruso');
    RAISE EXCEPTION 'FALLO 4: la otra cuenta escribió en DULMO';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.dulmo_proyectos (account_id, cliente_nombre)
    VALUES (current_setting('t300.otra')::uuid, 'sin app');
    RAISE EXCEPTION 'FALLO 4b: una cuenta sin la app pudo escribir';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE public.dulmo_proyectos SET cliente_nombre = 'x';
  IF FOUND THEN RAISE EXCEPTION 'FALLO 4c: la otra cuenta actualizó filas'; END IF;
END $$;

-- Caso 5: rutas de Storage
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '3000c000-0000-4000-8000-000000000001', true);
  IF NOT public.dulmo_puede_ruta('dulmo', current_setting('t300.dulmo') || '/p/foto.jpg') THEN
    RAISE EXCEPTION 'FALLO 5: Moni no puede su ruta';
  END IF;
  IF public.dulmo_puede_ruta('dulmo', 'no-es-uuid/foto.jpg') THEN RAISE EXCEPTION 'FALLO 5b'; END IF;
  IF public.dulmo_puede_ruta('marketing', current_setting('t300.dulmo') || '/foto.jpg') THEN
    RAISE EXCEPTION 'FALLO 5c: otro bucket';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '3000c000-0000-4000-8000-000000000002', true);
  IF public.dulmo_puede_ruta('dulmo', current_setting('t300.dulmo') || '/p/foto.jpg') THEN
    RAISE EXCEPTION 'FALLO 5d: la otra cuenta puede la ruta de DULMO';
  END IF;
END $$;

RESET ROLE;

-- Caso 6: anon sin permisos
DO $$
BEGIN
  IF has_table_privilege('anon', 'public.dulmo_proyectos', 'SELECT')
     OR has_table_privilege('anon', 'public.dulmo_mediciones', 'SELECT')
     OR has_table_privilege('anon', 'public.dulmo_ajustes', 'SELECT')
     OR has_function_privilege('anon', 'public.dulmo_my_access()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALLO 6: anon tiene permisos';
  END IF;
  RAISE NOTICE '300: todos los casos OK';
END $$;

ROLLBACK;
