-- ============================================================
-- 044_client_identity.sql — The DNI, so a client can get in
--
-- Golden Habitat's clients will open the Golden App and enter with their
-- phone number and their DNI: no account, no password, no email. For that
-- the CRM has to hold the DNI of each client, and the app has to be able
-- to look up "this phone + this DNI" fast.
--
-- Why a column on `contacts` and not a custom field: `custom_fields` here
-- is the original per-USER table (`user_id`, `field_name`) from migration
-- 001, not per account, and its values live in a second table. Identity
-- that gates access belongs next to the phone it is checked against.
--
-- What this does NOT do: grant clients any read access. The portal reads
-- their data through the server, which checks the pair itself; after 041
-- a viewer of a client account is not a member of the account, so no RLS
-- policy here opens up to them.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS dni TEXT,
  -- Who typed it in and when: if a client can't get in, the advisor who
  -- registered the number is the person to ask.
  ADD COLUMN IF NOT EXISTS dni_registered_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dni_registered_at TIMESTAMPTZ;

-- Peru's DNI is 8 digits; CE (foreign residents) runs longer. Digits only,
-- 8 to 12, so "12345678 " or "DNI 12345678" never reaches the lookup and
-- silently locks someone out.
ALTER TABLE contacts
  DROP CONSTRAINT IF EXISTS contacts_dni_format;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_dni_format
  CHECK (dni IS NULL OR dni ~ '^[0-9]{8,12}$');

-- Two clients can't share a DNI inside one account: that would make the
-- phone+DNI pair ambiguous. Partial, so the many contacts without a DNI
-- are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_dni
  ON contacts(account_id, dni)
  WHERE dni IS NOT NULL;

-- The login lookup: phone first (already normalised by migration 022),
-- then the DNI is compared in the server.
CREATE INDEX IF NOT EXISTS idx_contacts_account_phone_normalized
  ON contacts(account_id, phone_normalized);

-- ============================================================
-- How full is the cartera? The advisors have to fill this in before
-- anyone can enter, so the office needs to see what's missing:
--
--   SELECT count(*) FILTER (WHERE dni IS NULL) AS sin_dni,
--          count(*) FILTER (WHERE dni IS NOT NULL) AS con_dni
--     FROM contacts
--    WHERE account_id = '<cuenta>';
-- ============================================================
