-- ============================================================
-- 036_meta_leads_config.sql — Meta Lead Ads integration (per account)
--
-- Lets each account connect its own Meta App + Facebook/Instagram Page
-- so lead-form submissions (the `leadgen` webhook) flow into the CRM and
-- auto-assign to an advisor via the round-robin automation.
--
-- Per-account, self-service (chosen over global env vars): each account
-- gets its OWN webhook URL, keyed by an unguessable `webhook_token`:
--
--     https://<host>/api/meta/leads/<webhook_token>
--
-- That token in the path is how the single webhook route resolves which
-- account (and thus which App Secret / Page token) a delivery belongs to,
-- so two accounts can bring two independent Meta Apps to one deployment.
--
-- Secrets at rest: `app_secret` and `page_access_token` are AES-256-GCM
-- encrypted with ENCRYPTION_KEY (same scheme as whatsapp_config.access_token,
-- see src/lib/whatsapp/encryption.ts). `verify_token` is stored plaintext —
-- it is a shared handshake string (the user also types it into Meta), not
-- a secret, and the GET challenge must compare it directly.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS meta_leads_config (
  -- One config per account. account_id is both PK and tenancy key.
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- Audit: which member saved it.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Unguessable id embedded in the account's webhook URL.
  webhook_token TEXT NOT NULL UNIQUE,
  -- AES-256-GCM ciphertext (iv:ct:tag). Used for HMAC verification.
  app_secret TEXT,
  -- Plaintext handshake string for the GET verification challenge.
  verify_token TEXT,
  -- AES-256-GCM ciphertext. Used to fetch lead detail from the Graph API.
  page_access_token TEXT,
  -- Optional: the Facebook Page id, for reference / routing sanity checks.
  page_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The webhook resolves config by token on every delivery.
CREATE INDEX IF NOT EXISTS idx_meta_leads_config_token
  ON meta_leads_config(webhook_token);

ALTER TABLE meta_leads_config ENABLE ROW LEVEL SECURITY;

-- Admins/owners of the account manage the config (credentials are
-- sensitive). The webhook itself reads via the service-role client, so it
-- bypasses these policies. Mirrors the account-membership gating added in
-- 017_account_sharing.sql (is_account_member(account_id, min_role)).
DROP POLICY IF EXISTS meta_leads_config_select ON meta_leads_config;
CREATE POLICY meta_leads_config_select ON meta_leads_config FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS meta_leads_config_insert ON meta_leads_config;
CREATE POLICY meta_leads_config_insert ON meta_leads_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS meta_leads_config_update ON meta_leads_config;
CREATE POLICY meta_leads_config_update ON meta_leads_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS meta_leads_config_delete ON meta_leads_config;
CREATE POLICY meta_leads_config_delete ON meta_leads_config FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON meta_leads_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON meta_leads_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
