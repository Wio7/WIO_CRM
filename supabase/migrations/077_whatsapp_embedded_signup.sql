-- Embedded Signup: conserva los registros y las lecturas existentes.
ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS business_id TEXT,
  ADD COLUMN IF NOT EXISTS connection_type TEXT NOT NULL DEFAULT 'manual'
    CHECK (connection_type IN ('manual', 'embedded', 'coexistence')),
  ADD COLUMN IF NOT EXISTS is_on_biz_app BOOLEAN,
  ADD COLUMN IF NOT EXISTS platform_type TEXT,
  ADD COLUMN IF NOT EXISTS history_sync_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contacts_sync_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS history_sync_status TEXT,
  ADD COLUMN IF NOT EXISTS last_signup_error TEXT;
