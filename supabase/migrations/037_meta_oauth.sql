-- ============================================================
-- 037_meta_oauth.sql — "Connect with Facebook" (Meta Login for Business)
--
-- Migration 036 let an account paste a Page Access Token it obtained by
-- hand in the Graph API Explorer. That works but is unusable for a
-- non-technical operator. This migration backs the OAuth flow instead:
-- the admin clicks "Conectar con Facebook", authenticates on Meta's own
-- domain (we never see the password), and we store the resulting tokens.
--
-- Two connection models now coexist, on purpose:
--
--   * Shared app (this migration) — every tenant authorizes OUR Meta App
--     (WIO.CRM). Meta then delivers every tenant's leads to ONE app-level
--     callback, so the receiving webhook resolves the tenant from the
--     event's page_id via `meta_pages`. Hence the GLOBAL unique index on
--     page_id below: one Facebook Page maps to exactly one CRM account,
--     otherwise routing a delivery would be ambiguous.
--
--   * Own app (migration 036) — an account brings its own Meta App and
--     gets a private webhook URL keyed by `webhook_token`. Kept intact as
--     the advanced path; nothing here replaces it.
--
-- Token lifetimes: we exchange the short-lived user token for a
-- long-lived one (~60 days) BEFORE calling /me/accounts, because Page
-- tokens derived from a long-lived user token do not expire. That's why
-- `meta_pages.page_access_token` needs no refresh machinery while
-- `meta_connections.token_expires_at` does get tracked.
--
-- Secrets at rest: user and page tokens are AES-256-GCM encrypted with
-- ENCRYPTION_KEY, same helper as whatsapp_config.access_token
-- (src/lib/whatsapp/encryption.ts).
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- meta_connections — one authorized Facebook identity per account.
-- ============================================================
CREATE TABLE IF NOT EXISTS meta_connections (
  account_id         UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- Which member ran the OAuth flow (audit).
  connected_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Facebook user that granted access.
  fb_user_id         TEXT,
  fb_user_name       TEXT,
  -- AES-256-GCM ciphertext of the long-lived user token.
  user_access_token  TEXT,
  -- ~60 days out. Surfaced in the UI so the admin can re-connect before
  -- it lapses; Page tokens themselves keep working, but re-listing pages
  -- after expiry requires a fresh grant.
  token_expires_at   TIMESTAMPTZ,
  -- Scopes actually granted (Meta may grant fewer than requested if the
  -- user unticks permissions on the consent screen).
  scopes             TEXT[] NOT NULL DEFAULT '{}',
  connected_at       TIMESTAMPTZ,
  -- Last Graph API failure, shown in settings instead of failing silently.
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE meta_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_connections_select ON meta_connections;
CREATE POLICY meta_connections_select ON meta_connections FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS meta_connections_insert ON meta_connections;
CREATE POLICY meta_connections_insert ON meta_connections FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS meta_connections_update ON meta_connections;
CREATE POLICY meta_connections_update ON meta_connections FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS meta_connections_delete ON meta_connections;
CREATE POLICY meta_connections_delete ON meta_connections FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON meta_connections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON meta_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- meta_pages — the Facebook Pages an account has connected.
--
-- A row exists for every page returned by /me/accounts; `is_active`
-- distinguishes "we know about it" from "subscribed to leadgen".
-- ============================================================
CREATE TABLE IF NOT EXISTS meta_pages (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  page_id            TEXT NOT NULL,
  page_name          TEXT,
  -- AES-256-GCM ciphertext. Non-expiring (see header note on token
  -- lifetimes); used to fetch lead detail from the Graph API.
  page_access_token  TEXT,
  -- Set when POST /{page_id}/subscribed_apps succeeded. NULL means the
  -- page is known but not receiving leads yet — same "saved vs actually
  -- live" split whatsapp_config.registered_at draws (migration 015).
  subscribed_at      TIMESTAMPTZ,
  is_active          BOOLEAN NOT NULL DEFAULT FALSE,
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, page_id)
);

-- Webhook routing key: the shared-app callback receives every tenant's
-- deliveries and resolves the account by page_id alone, so a page must
-- belong to at most ONE account globally. A second account attempting to
-- connect the same page fails loudly here rather than silently hijacking
-- the first account's leads.
CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_pages_page_id_global
  ON meta_pages(page_id);

CREATE INDEX IF NOT EXISTS idx_meta_pages_account
  ON meta_pages(account_id);

ALTER TABLE meta_pages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_pages_select ON meta_pages;
CREATE POLICY meta_pages_select ON meta_pages FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS meta_pages_insert ON meta_pages;
CREATE POLICY meta_pages_insert ON meta_pages FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS meta_pages_update ON meta_pages;
CREATE POLICY meta_pages_update ON meta_pages FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS meta_pages_delete ON meta_pages;
CREATE POLICY meta_pages_delete ON meta_pages FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON meta_pages;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON meta_pages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- meta_lead_events — processed leadgen ids, for idempotency.
--
-- Meta retries a webhook delivery until it gets a 200, and can redeliver
-- even after one. Without this, a retry re-runs the whole capture: the
-- contact itself is safe (captureLead dedupes on phone) but the "extra
-- form answers" note would be appended again and the new_contact_created
-- automation could re-fire. The PK is the dedupe.
--
-- Service-role only: written exclusively by the webhook, never read by
-- the dashboard. RLS on with no policies = no access for authenticated
-- or anon roles (same posture as automation_assignment_state in 034).
-- ============================================================
CREATE TABLE IF NOT EXISTS meta_lead_events (
  leadgen_id    TEXT PRIMARY KEY,
  account_id    UUID REFERENCES accounts(id) ON DELETE CASCADE,
  page_id       TEXT,
  form_id       TEXT,
  contact_id    UUID REFERENCES contacts(id) ON DELETE SET NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meta_lead_events_account
  ON meta_lead_events(account_id, processed_at DESC);

ALTER TABLE meta_lead_events ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- contacts.ctwa_clid — Click-to-WhatsApp click id.
--
-- Meta stamps this on the `referral` object of the first inbound WhatsApp
-- message when the conversation started from a Click-to-WhatsApp ad. The
-- other attribution columns already exist (migration 035); this one is
-- separate because it is the join key for Meta's Conversions API, should
-- we later want to report closed deals back to Meta as conversions.
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS ctwa_clid TEXT;
