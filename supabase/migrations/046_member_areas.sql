-- ============================================================
-- 046_member_areas.sql — What each member of the team does
--
-- The account role (owner / admin / agent / viewer) says how much power
-- someone has. It doesn't say what they DO, and Golden Habitat works by
-- areas: the same "admin" power belongs to marketing, to legal, to
-- collections or to the head of the sales floor, and each of them should
-- only be handed their own work.
--
--   profiles.area   marketing | legal | cobranzas | ventas  (or null)
--
-- Why a column and not new roles in `account_role_enum`: every RLS policy
-- in this database is written against that enum's four values. Adding
-- values there would mean rewriting them all, and a mistake would open or
-- close the whole CRM for everyone. The area rides ALONGSIDE the role:
-- the role keeps deciding what the database allows, the area decides what
-- the app puts in front of you and who gets notified.
--
-- What each area is for, as agreed with the user:
--   marketing   the catalogue: photos, texts, prices  (Golden App)
--   legal       lot separations: approves, rejects, opens the voucher
--   cobranzas   instalments and the vouchers clients upload
--   ventas      head of advisors: follows what the agents are doing
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS area TEXT,
  ADD COLUMN IF NOT EXISTS area_set_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS area_set_at TIMESTAMPTZ;

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_area_check;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_area_check
  CHECK (area IS NULL OR area IN ('marketing', 'legal', 'cobranzas', 'ventas'));

-- Who is on collections / legal, asked on every client voucher.
CREATE INDEX IF NOT EXISTS idx_profiles_account_area
  ON profiles(account_id, area)
  WHERE area IS NOT NULL;

-- ============================================================
-- set_member_area — the only way the area changes
--
-- Same shape as set_member_role (040): SECURITY DEFINER, checks the
-- caller instead of trusting the client. An admin can hand out areas; an
-- area is not power, so it doesn't need to be owner-only, but the target
-- must be a member of the caller's account.
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
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_account FROM profiles WHERE user_id = auth.uid();
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_area IS NOT NULL AND p_area NOT IN ('marketing', 'legal', 'cobranzas', 'ventas') THEN
    RAISE EXCEPTION 'Unknown area: %', p_area USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE user_id = p_user_id AND account_id = v_account
  ) THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '22023';
  END IF;

  UPDATE profiles
     SET area = p_area,
         area_set_by = (SELECT id FROM profiles WHERE user_id = auth.uid()),
         area_set_at = NOW()
   WHERE user_id = p_user_id AND account_id = v_account;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_member_area(UUID, TEXT) TO authenticated;

-- The roster the Golden App shows comes from GET /api/account/members,
-- which selects straight from `profiles`; that route now asks for `area`
-- too. Nothing else to do here.
