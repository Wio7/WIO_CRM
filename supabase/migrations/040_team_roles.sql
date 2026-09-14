-- ============================================================
-- 040_team_roles.sql — Several owners, owner-only ownership grants,
--                      email-addressed invitations
--
-- Before: one owner per account, promotions only by transferring the
-- whole account, and invitations could never carry the owner role.
-- Real teams have co-owners (e.g. two partners of a real-estate firm),
-- so:
--
--   · An account can have any number of members with role 'owner'.
--   · accounts.owner_user_id stays as the PRIMARY owner — the one who
--     created/holds the account. Nobody can change that member's role
--     or remove them; handing it over still goes through
--     transfer_account_ownership.
--   · Only an owner can grant the owner role or take it away (invite
--     as owner, promote to owner, demote/remove another owner).
--     Admins keep managing admins, agents and viewers.
--   · account_invitations may carry role 'owner' and an optional
--     recipient email (the app now emails the invitation).
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. Invitations: allow 'owner', store the recipient email
-- ============================================================
ALTER TABLE account_invitations
  DROP CONSTRAINT IF EXISTS account_invitations_role_check;

ALTER TABLE account_invitations
  ADD COLUMN IF NOT EXISTS email TEXT;

-- Only an owner may create (or re-role) an owner invitation. Server
-- code running with the service role (no auth.uid()) is trusted.
CREATE OR REPLACE FUNCTION guard_owner_invitation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.role = 'owner'
     AND auth.uid() IS NOT NULL
     AND NOT is_account_member(NEW.account_id, 'owner') THEN
    RAISE EXCEPTION 'Only an owner can invite another owner'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION guard_owner_invitation() OWNER TO postgres;

DROP TRIGGER IF EXISTS guard_owner_invitation ON account_invitations;
CREATE TRIGGER guard_owner_invitation
  BEFORE INSERT OR UPDATE OF role ON account_invitations
  FOR EACH ROW EXECUTE FUNCTION guard_owner_invitation();

-- ============================================================
-- 2. set_member_role — owners may grant/remove the owner role
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
-- 3. remove_account_member — owners may remove other owners
--    (never the primary owner)
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

  IF v_target_role = 'owner' AND v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only an owner can remove another owner'
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
