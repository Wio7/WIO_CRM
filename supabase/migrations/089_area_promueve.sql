-- ============================================================
-- 089_area_promueve.sql — Área "Promueve" (asesores externos) + registro por código
--
-- Casos: supabase/tests/089_casos.sql (correr DESPUÉS de aplicar esta).
-- Requiere: 085_conexiones.sql aplicada (set_member_area con 'tecnica').
--
-- Promueve = asesores de venta EXTERNOS: no son de la empresa ni están en
-- planilla; venden los lotes de Golden por comisión. Crean su propio acceso
-- en la Golden App con un código de invitación que reparte el dueño.
--
-- Qué cambia:
--   1. Área 'promueve' en profiles.area y en set_member_area.
--   2. is_account_member() ya NO cuenta como miembro a quien tiene
--      area = 'promueve'. Es la puerta que usan casi todas las políticas
--      RLS y funciones (contactos, conversaciones, planes, pagos, caja,
--      traspasos, postventa, tienda...): negar aquí las cierra todas a la
--      vez y también las que se creen después. Un Promueve solo lee su
--      propia fila de profiles (profiles_select: auth.uid() = user_id).
--      has_full_access / can_access_module / is_owner_or_gerencia quedan
--      cerradas por la misma vía (dependen de is_account_member).
--   3. pick_account_agent (reparto round-robin de chats nuevos) salta a
--      los Promueve: no son del equipo y no deben recibir clientes.
--   4. promueve_invites: códigos de invitación (solo el hash SHA-256).
--      RPC para dueño / gerencia / super admin: promueve_invite_create,
--      promueve_invite_set_active, promueve_invites_list.
--   5. promueve_check_code y promueve_registrar: solo service_role. Las
--      llama POST /api/promueve/registro. promueve_registrar mueve el
--      perfil recién creado al account de Golden como agent/promueve en
--      UNA transacción y consume el uso del código.
--
-- Idempotente — se puede volver a correr.
-- ============================================================
BEGIN;

-- ============================================================
-- 1. Área
-- ============================================================
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_area_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_area_check
  CHECK (area IS NULL OR area IN ('marketing', 'legal', 'cobranzas', 'ventas', 'gerencia', 'contabilidad', 'tecnica', 'promueve'));

-- Celular de contacto (los externos no tienen correo de empresa). Solo lo
-- escribe el registro (service_role) y el propio usuario; lo lee quien ya
-- lee el perfil.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS contact_phone text;

-- set_member_area de 085 con 'promueve'; el resto igual.
CREATE OR REPLACE FUNCTION public.set_member_area(
  p_user_id UUID,
  p_area TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_account, v_caller_role
  FROM profiles WHERE user_id = auth.uid();

  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_area IS NOT NULL
     AND p_area NOT IN ('marketing', 'legal', 'cobranzas', 'ventas', 'gerencia', 'contabilidad', 'tecnica', 'promueve') THEN
    RAISE EXCEPTION 'Unknown area: %', p_area USING ERRCODE = '22023';
  END IF;

  SELECT account_role INTO v_target_role
  FROM profiles
  WHERE user_id = p_user_id AND account_id = v_account;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '22023';
  END IF;

  IF v_caller_role = 'admin' AND v_target_role IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only an owner can change an admin''s area'
      USING ERRCODE = '42501';
  END IF;

  IF v_caller_role <> 'owner' AND p_area = 'gerencia' THEN
    RAISE EXCEPTION 'Only an owner can grant the gerencia area'
      USING ERRCODE = '42501';
  END IF;

  IF v_caller_role <> 'owner'
     AND (SELECT area FROM profiles WHERE user_id = p_user_id AND account_id = v_account) = 'gerencia' THEN
    RAISE EXCEPTION 'Only an owner can change a gerencia member''s area'
      USING ERRCODE = '42501';
  END IF;

  -- Un Promueve es siempre agente externo: no se le pone esta área a un
  -- dueño ni a un administrador (quedaría con el rol alto y sin acceso).
  IF p_area = 'promueve' AND v_target_role IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Promueve solo se asigna a agentes' USING ERRCODE = '22023';
  END IF;

  UPDATE profiles
     SET area = p_area,
         area_set_by = (SELECT id FROM profiles WHERE user_id = auth.uid()),
         area_set_at = NOW()
   WHERE user_id = p_user_id AND account_id = v_account;
END;
$$;

ALTER FUNCTION public.set_member_area(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_area(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_area(UUID, TEXT) TO authenticated;

-- ============================================================
-- 2. Un Promueve no es "miembro" para las políticas
--
-- 067 + "AND p.area IS DISTINCT FROM 'promueve'". Cualquier política o
-- función que pregunte is_account_member (todas las de datos del CRM) lo
-- trata como a alguien de afuera. Sigue pudiendo iniciar sesión y leer su
-- propia fila de profiles (profiles_select: auth.uid() = user_id).
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    JOIN public.accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND p.area IS DISTINCT FROM 'promueve'
      AND (a.status = 'active' OR public.is_super_admin())
      AND NOT (p.account_role = 'viewer' AND a.viewers_are_clients)
      AND CASE p.account_role
            WHEN 'owner' THEN 4 WHEN 'admin' THEN 3
            WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1
          END >= CASE min_role
            WHEN 'owner' THEN 4 WHEN 'admin' THEN 3
            WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1
          END
  );
$$;
ALTER FUNCTION public.is_account_member(UUID, account_role_enum) OWNER TO postgres;

-- ============================================================
-- 3. Reparto de chats nuevos: sin Promueve
-- (039 + AND p.area IS DISTINCT FROM 'promueve' en las dos consultas)
-- ============================================================
CREATE OR REPLACE FUNCTION pick_account_agent(p_account_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_counts JSONB;
  v_min    BIGINT;
  v_best   BIGINT;
  v_chosen UUID;
  v_count  BIGINT;
  v_agent  RECORD;
BEGIN
  INSERT INTO account_assignment_state (account_id)
    VALUES (p_account_id)
    ON CONFLICT (account_id) DO NOTHING;

  SELECT counts INTO v_counts
    FROM account_assignment_state
    WHERE account_id = p_account_id
    FOR UPDATE;

  SELECT MIN((v_counts ->> p.user_id::text)::BIGINT) INTO v_min
    FROM profiles p
    WHERE p.account_id = p_account_id
      AND p.account_role = 'agent'
      AND p.area IS DISTINCT FROM 'promueve'
      AND v_counts ? p.user_id::text;

  FOR v_agent IN
    SELECT p.user_id
      FROM profiles p
      WHERE p.account_id = p_account_id
        AND p.account_role = 'agent'
        AND p.area IS DISTINCT FROM 'promueve'
      ORDER BY p.created_at, p.user_id
  LOOP
    v_count := COALESCE((v_counts ->> v_agent.user_id::text)::BIGINT, v_min, 0);
    IF v_chosen IS NULL OR v_count < v_best THEN
      v_chosen := v_agent.user_id;
      v_best := v_count;
    END IF;
  END LOOP;

  IF v_chosen IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE account_assignment_state
     SET counts = jsonb_set(v_counts, ARRAY[v_chosen::text], to_jsonb(v_best + 1)),
         updated_at = NOW()
   WHERE account_id = p_account_id;

  RETURN v_chosen;
END;
$$;

ALTER FUNCTION pick_account_agent(UUID) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION pick_account_agent(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pick_account_agent(UUID) TO service_role;

-- ============================================================
-- 4. Códigos de invitación
-- ============================================================
CREATE TABLE IF NOT EXISTS public.promueve_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- SHA-256 (hex) del código en mayúsculas y sin espacios. El código en claro
  -- no se guarda: solo lo ve quien lo crea, una vez.
  code_hash   text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  label       text CHECK (label IS NULL OR char_length(label) <= 80),
  active      boolean NOT NULL DEFAULT true,
  uses        integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  -- NULL = sin límite de usos.
  max_uses    integer CHECK (max_uses IS NULL OR max_uses > 0),
  expires_at  timestamptz,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Un código identifica una invitación (si no, el registro no sabría a qué cuenta va).
CREATE UNIQUE INDEX IF NOT EXISTS promueve_invites_code_hash_key
  ON public.promueve_invites(code_hash);
CREATE INDEX IF NOT EXISTS idx_promueve_invites_account
  ON public.promueve_invites(account_id, created_at DESC);

-- Sin políticas ni permisos de tabla: todo pasa por las funciones de abajo.
ALTER TABLE public.promueve_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.promueve_invites FROM PUBLIC, anon, authenticated;

-- Normalización única: mayúsculas, sin espacios ni guiones.
-- (Mismo criterio en src/lib/promueve/codigo.ts.)
CREATE OR REPLACE FUNCTION public.promueve_hash_code(p_code text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT encode(sha256(convert_to(upper(regexp_replace(COALESCE(p_code, ''), '[\s-]', '', 'g')), 'UTF8')), 'hex');
$$;
REVOKE ALL ON FUNCTION public.promueve_hash_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promueve_hash_code(text) TO authenticated, service_role;

-- Crea un código. Si p_code es NULL se genera uno de 12 caracteres (48 bits,
-- AAAA-BBBB-CCCC al mostrarlo). Devuelve el código en claro UNA vez.
-- Solo dueño, super admin o gerencia de la cuenta del que llama.
CREATE OR REPLACE FUNCTION public.promueve_invite_create(
  p_label      text DEFAULT NULL,
  p_max_uses   integer DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_code       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
  v_code    text;
  v_norm    text;
  v_id      uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501';
  END IF;
  SELECT account_id INTO v_account FROM profiles WHERE user_id = auth.uid();
  IF v_account IS NULL OR NOT public.is_owner_or_gerencia(v_account) THEN
    RAISE EXCEPTION 'Solo el dueño o gerencia crean códigos' USING ERRCODE = '42501';
  END IF;
  IF p_max_uses IS NOT NULL AND p_max_uses <= 0 THEN
    RAISE EXCEPTION 'El límite de usos debe ser mayor que 0' USING ERRCODE = '22023';
  END IF;

  IF p_code IS NULL THEN
    v_norm := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
    v_code := substr(v_norm, 1, 4) || '-' || substr(v_norm, 5, 4) || '-' || substr(v_norm, 9, 4);
  ELSE
    v_norm := upper(regexp_replace(p_code, '[\s-]', '', 'g'));
    IF char_length(v_norm) < 8 OR v_norm !~ '^[A-Z0-9]+$' THEN
      RAISE EXCEPTION 'El código debe tener al menos 8 letras o números' USING ERRCODE = '22023';
    END IF;
    v_code := v_norm;
  END IF;

  BEGIN
    INSERT INTO promueve_invites (account_id, code_hash, label, max_uses, expires_at, created_by)
    VALUES (v_account, public.promueve_hash_code(v_norm), NULLIF(left(trim(p_label), 80), ''),
            p_max_uses, p_expires_at, auth.uid())
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Ese código ya existe; elige otro' USING ERRCODE = '23505';
  END;

  RETURN jsonb_build_object('id', v_id, 'code', v_code);
END;
$$;

CREATE OR REPLACE FUNCTION public.promueve_invite_set_active(p_id uuid, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501';
  END IF;
  SELECT account_id INTO v_account FROM profiles WHERE user_id = auth.uid();
  IF v_account IS NULL OR NOT public.is_owner_or_gerencia(v_account) THEN
    RAISE EXCEPTION 'Solo el dueño o gerencia gestionan códigos' USING ERRCODE = '42501';
  END IF;
  UPDATE promueve_invites SET active = COALESCE(p_active, false)
   WHERE id = p_id AND account_id = v_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Código no encontrado' USING ERRCODE = '22023';
  END IF;
END;
$$;

-- Lista (sin el hash). 'estado': activo | desactivado | vencido | agotado.
CREATE OR REPLACE FUNCTION public.promueve_invites_list()
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501';
  END IF;
  SELECT account_id INTO v_account FROM profiles WHERE user_id = auth.uid();
  IF v_account IS NULL OR NOT public.is_owner_or_gerencia(v_account) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT jsonb_build_object(
           'id', i.id, 'label', i.label, 'active', i.active, 'uses', i.uses,
           'max_uses', i.max_uses, 'expires_at', i.expires_at, 'created_at', i.created_at,
           'estado', CASE WHEN NOT i.active THEN 'desactivado'
                          WHEN i.expires_at IS NOT NULL AND i.expires_at <= now() THEN 'vencido'
                          WHEN i.max_uses IS NOT NULL AND i.uses >= i.max_uses THEN 'agotado'
                          ELSE 'activo' END)
    FROM promueve_invites i
   WHERE i.account_id = v_account
   ORDER BY i.created_at DESC, i.id DESC;
END;
$$;

-- ¿El código sirve? Devuelve el account_id o NULL. Solo service_role (el
-- endpoint público lo llama ANTES de crear el usuario de Auth).
CREATE OR REPLACE FUNCTION public.promueve_check_code(p_code_hash text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.account_id
    FROM promueve_invites i
   WHERE i.code_hash = p_code_hash
     AND i.active
     AND (i.expires_at IS NULL OR i.expires_at > now())
     AND (i.max_uses IS NULL OR i.uses < i.max_uses);
$$;

-- Registro atómico. El usuario de Auth ya existe (el trigger handle_new_user
-- le creó una cuenta personal vacía como dueño). En UNA transacción:
-- consume un uso del código, mueve su perfil al account del código como
-- agent / promueve y borra la cuenta personal. Si algo falla, no cambia nada.
CREATE OR REPLACE FUNCTION public.promueve_registrar(
  p_user_id   uuid,
  p_full_name text,
  p_phone     text,
  p_code_hash text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv     promueve_invites%ROWTYPE;
  v_old     uuid;
  v_old_own uuid;
  v_role    account_role_enum;
BEGIN
  SELECT * INTO v_inv FROM promueve_invites WHERE code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND OR NOT v_inv.active
     OR (v_inv.expires_at IS NOT NULL AND v_inv.expires_at <= now())
     OR (v_inv.max_uses IS NOT NULL AND v_inv.uses >= v_inv.max_uses) THEN
    RAISE EXCEPTION 'Código no válido' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id, p.account_role INTO v_old, v_old_own, v_role
    FROM profiles p JOIN accounts a ON a.id = p.account_id
   WHERE p.user_id = p_user_id;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'El usuario no tiene perfil' USING ERRCODE = '22023';
  END IF;
  IF v_old = v_inv.account_id THEN
    RAISE EXCEPTION 'El usuario ya está en esa cuenta' USING ERRCODE = '23505';
  END IF;
  -- Solo una cuenta personal recién nacida: dueño único y sin datos.
  IF v_old_own <> p_user_id OR v_role <> 'owner' OR EXISTS (
       SELECT 1 FROM contacts WHERE account_id = v_old
       UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old LIMIT 1) THEN
    RAISE EXCEPTION 'El usuario ya tiene una cuenta con datos' USING ERRCODE = '23505';
  END IF;

  UPDATE profiles
     SET account_id = v_inv.account_id,
         account_role = 'agent',
         area = 'promueve',
         area_set_at = now(),
         full_name = left(trim(p_full_name), 80),
         contact_phone = left(trim(p_phone), 20)
   WHERE user_id = p_user_id;

  UPDATE promueve_invites SET uses = uses + 1 WHERE id = v_inv.id;

  DELETE FROM accounts WHERE id = v_old;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.promueve_hash_code(text) OWNER TO postgres;
ALTER FUNCTION public.promueve_invite_create(text, integer, timestamptz, text) OWNER TO postgres;
ALTER FUNCTION public.promueve_invite_set_active(uuid, boolean) OWNER TO postgres;
ALTER FUNCTION public.promueve_invites_list() OWNER TO postgres;
ALTER FUNCTION public.promueve_check_code(text) OWNER TO postgres;
ALTER FUNCTION public.promueve_registrar(uuid, text, text, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.promueve_invite_create(text, integer, timestamptz, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.promueve_invite_set_active(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.promueve_invites_list() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.promueve_check_code(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.promueve_registrar(uuid, text, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.promueve_invite_create(text, integer, timestamptz, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.promueve_invite_set_active(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.promueve_invites_list() TO authenticated;
GRANT EXECUTE ON FUNCTION public.promueve_check_code(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.promueve_registrar(uuid, text, text, text) TO service_role;

COMMENT ON TABLE public.promueve_invites IS
  'Códigos de invitación para asesores externos Promueve. Solo el hash; se gestionan con promueve_invite_create / _set_active / _list y se canjean en POST /api/promueve/registro.';

COMMIT;

-- PostgREST lee el esquema nuevo sin reiniciar.
NOTIFY pgrst, 'reload schema';
