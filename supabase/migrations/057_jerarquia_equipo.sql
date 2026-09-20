-- ============================================================
-- 057_jerarquia_equipo.sql — un administrador no manda sobre otro
--
-- Hoy cualquier administrador puede cambiarle el rol, el área o sacar del
-- equipo a OTRO administrador, incluido su propio jefe: la 040 sólo
-- protegía al dueño. En Golden eso significa que el administrador de
-- cobranzas puede degradar a la jefa de ventas, y que un asesor ascendido
-- a administrador por error se reparte los permisos de toda la casa.
--
-- La regla que queda:
--
--   dueño            manda sobre todos (menos sobre el dueño principal)
--   administrador    manda sólo sobre asesores y solo-lectura, y sólo
--                    puede repartir esos dos roles
--   asesor / viewer  no manda sobre nadie
--
-- Vale para las tres puertas: cambiar el rol, cambiar el área y quitar a
-- alguien del equipo. La pantalla Equipo de la app deja de ofrecer lo que
-- aquí se rechaza, pero la decisión vive aquí.
--
-- Idempotente — se puede volver a correr.
-- ============================================================

-- ============================================================
-- 1. set_member_role
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_member_role(
  p_user_id UUID,
  p_new_role account_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_primary_owner UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  SELECT owner_user_id INTO v_primary_owner
  FROM accounts
  WHERE id = v_caller_account_id;

  IF p_user_id = v_primary_owner THEN
    RAISE EXCEPTION 'The primary owner''s role cannot be changed; use transfer_account_ownership'
      USING ERRCODE = '22023';
  END IF;

  -- Un administrador manda sobre asesores y solo-lectura, y nada más: ni
  -- sobre otro administrador, ni sobre un dueño, ni repartiendo esos dos
  -- roles. Sólo un dueño hace administradores.
  IF v_caller_role = 'admin'
     AND (v_target_role IN ('owner', 'admin') OR p_new_role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'Only an owner can change an admin or grant the admin role'
      USING ERRCODE = '42501';
  END IF;

  IF (v_target_role = 'owner' OR p_new_role = 'owner')
     AND v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only an owner can grant or remove the owner role'
      USING ERRCODE = '42501';
  END IF;

  UPDATE profiles
  SET account_role = p_new_role
  WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.set_member_role(UUID, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_role(UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, account_role_enum) TO authenticated;

-- ============================================================
-- 2. set_member_area — el área es el trabajo de alguien, y el trabajo de
--    un administrador se lo cambia un dueño.
-- ============================================================
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

  IF p_area IS NOT NULL AND p_area NOT IN ('marketing', 'legal', 'cobranzas', 'ventas') THEN
    RAISE EXCEPTION 'Unknown area: %', p_area USING ERRCODE = '22023';
  END IF;

  SELECT account_role INTO v_target_role
  FROM profiles
  WHERE user_id = p_user_id AND account_id = v_account;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '22023';
  END IF;

  IF v_caller_role = 'admin'
     AND v_target_role IN ('owner', 'admin')
     AND p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'Only an owner can change an admin''s area'
      USING ERRCODE = '42501';
  END IF;

  UPDATE profiles
     SET area = p_area,
         area_set_by = (SELECT id FROM profiles WHERE user_id = auth.uid()),
         area_set_at = NOW()
   WHERE user_id = p_user_id AND account_id = v_account;
END;
$$;

ALTER FUNCTION public.set_member_area(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_area(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_area(UUID, TEXT) TO authenticated;

-- ============================================================
-- 3. remove_account_member — tampoco se saca del equipo a un igual
-- ============================================================
CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS UUID  -- the new personal account id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_target_name TEXT;
  v_target_email TEXT;
  v_primary_owner UUID;
  v_new_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role, full_name, email
  INTO v_target_account_id, v_target_role, v_target_name, v_target_email
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  SELECT owner_user_id INTO v_primary_owner
  FROM accounts
  WHERE id = v_caller_account_id;

  IF p_user_id = v_primary_owner THEN
    RAISE EXCEPTION 'Cannot remove the primary owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  IF v_target_role IN ('owner', 'admin') AND v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only an owner can remove an owner or an admin'
      USING ERRCODE = '42501';
  END IF;

  -- Spin up a fresh personal account for the removed user. Mirror
  -- of handle_new_user's logic — keep them whole, just relocated.
  INSERT INTO accounts (name, owner_user_id)
  VALUES (
    COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'),
    p_user_id
  )
  RETURNING id INTO v_new_account_id;

  UPDATE profiles
  SET account_id = v_new_account_id,
      account_role = 'owner'
  WHERE user_id = p_user_id;

  RETURN v_new_account_id;
END;
$$;

ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;

COMMENT ON FUNCTION public.set_member_role(UUID, account_role_enum) IS
  'Cambia el rol de un miembro. Un administrador sólo manda sobre asesores y solo-lectura; hacer administradores o dueños es cosa del dueño.';
