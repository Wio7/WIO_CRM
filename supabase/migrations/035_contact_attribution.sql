-- ============================================================
-- 035_contact_attribution.sql — Campaign attribution on contacts
--
-- Adds where a lead came from so the CRM can tie a contact to the ad /
-- campaign / channel that produced it. Populated by the lead-capture
-- endpoint (POST /api/v1/leads) and, later, the Meta Lead Ads webhook.
--
--   lead_source   — coarse channel: 'meta_ads' | 'google_ads' | 'web' | ...
--   campaign_name — human-readable campaign label
--   ad_id         — provider-side ad / adset / form id (opaque string)
--   utm_*         — standard UTM parameters carried from landing pages
--
-- All nullable, all free-form TEXT — no enum, so new sources don't need
-- a migration. Attribution is first-touch: the capture endpoint only
-- fills a column that is currently NULL, never overwrites an existing
-- value (a contact's original source is preserved).
--
-- Idempotent — ADD COLUMN IF NOT EXISTS, safe to re-run.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lead_source   TEXT,
  ADD COLUMN IF NOT EXISTS campaign_name TEXT,
  ADD COLUMN IF NOT EXISTS ad_id         TEXT,
  ADD COLUMN IF NOT EXISTS utm_source    TEXT,
  ADD COLUMN IF NOT EXISTS utm_medium    TEXT,
  ADD COLUMN IF NOT EXISTS utm_campaign  TEXT,
  ADD COLUMN IF NOT EXISTS utm_term      TEXT,
  ADD COLUMN IF NOT EXISTS utm_content   TEXT;

-- Reporting hot path: "leads by source for this account".
CREATE INDEX IF NOT EXISTS idx_contacts_account_lead_source
  ON contacts(account_id, lead_source)
  WHERE lead_source IS NOT NULL;
