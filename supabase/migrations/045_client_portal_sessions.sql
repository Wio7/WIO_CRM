-- ============================================================
-- 045_client_portal_sessions.sql — Clients sign in with phone + DNI
--
-- Golden Habitat's clients open the Golden App and type their phone
-- and their DNI (044). No account, no password, no email: if the pair
-- matches a contact of an account that opened its client portal, the
-- server hands back a long-lived session token.
--
--   accounts.client_portal_enabled  which accounts accept client sign-in
--   client_sessions                 one row per signed-in phone; only the
--                                   SHA-256 of the token is stored
--   client_login_attempts           every try, to lock out guessing
--
-- A DNI is not a secret — it is printed on contracts and vouchers — so
-- the pair is only safe with a hard ceiling on guesses. The server
-- (src/lib/client-portal) locks a phone after 5 failed tries in 15
-- minutes and an IP after 30 in an hour, and tells the advisor. The
-- counts live here, not in memory, because Vercel runs many instances.
--
-- Neither table has an RLS policy: only the server (service role)
-- reads or writes them. Clients never get a Supabase session, so no
-- CRM policy ever opens up to them; everything they see comes through
-- routes that filter by the contact of their session.
--
-- Also: whoever types a DNI into a contact is recorded by a trigger,
-- so `dni_registered_by/at` can't be skipped by any write path.
--
-- Idempotent — safe to re-run. Requires 044.
-- ============================================================

-- ============================================================
-- 1. Per-account switch
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS client_portal_enabled BOOLEAN NOT NULL DEFAULT false;

-- Golden Habitat is the account the portal is being built for. A no-op
-- on any deployment where this id doesn't exist.
UPDATE accounts
   SET client_portal_enabled = true
 WHERE id = 'd74b5dfd-2999-4e2c-9a0e-10b3d540898b';

-- ============================================================
-- 2. Sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS client_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  -- Set when the client signs out, or when an advisor changes the DNI
  -- (below): a session opened with the old DNI must not survive it.
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_client_sessions_contact
  ON client_sessions(contact_id)
  WHERE revoked_at IS NULL;

ALTER TABLE client_sessions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3. Sign-in attempts
-- ============================================================
CREATE TABLE IF NOT EXISTS client_login_attempts (
  id BIGSERIAL PRIMARY KEY,
  -- Digits of what the client typed, not the contact's stored phone:
  -- guesses against numbers that aren't clients count too.
  phone_digits TEXT NOT NULL,
  ip TEXT NOT NULL,
  succeeded BOOLEAN NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_login_attempts_phone
  ON client_login_attempts(phone_digits, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_login_attempts_ip
  ON client_login_attempts(ip, created_at DESC);

ALTER TABLE client_login_attempts ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 4. Who registered the DNI, and sessions that die with an old DNI
-- ============================================================
CREATE OR REPLACE FUNCTION public.contacts_track_dni()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.dni IS DISTINCT FROM OLD.dni THEN
    IF NEW.dni IS NULL THEN
      NEW.dni_registered_by := NULL;
      NEW.dni_registered_at := NULL;
    ELSE
      -- auth.uid() is null for server writes (imports, the API): keep
      -- whatever the caller set rather than blanking it.
      NEW.dni_registered_by := COALESCE(
        (SELECT id FROM profiles WHERE user_id = auth.uid()),
        NEW.dni_registered_by
      );
      NEW.dni_registered_at := NOW();
    END IF;

    IF TG_OP = 'UPDATE' THEN
      UPDATE client_sessions
         SET revoked_at = NOW()
       WHERE contact_id = NEW.id
         AND revoked_at IS NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contacts_track_dni ON contacts;
CREATE TRIGGER contacts_track_dni
  BEFORE INSERT OR UPDATE OF dni ON contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_track_dni();

-- ============================================================
-- Housekeeping, by hand when the table grows:
--   DELETE FROM client_login_attempts WHERE created_at < NOW() - INTERVAL '90 days';
--   DELETE FROM client_sessions WHERE expires_at < NOW() - INTERVAL '30 days';
-- ============================================================
