-- ============================================================
-- 032_real_estate.sql — Real estate domain (projects, units, reservations)
--
-- Adds a real-estate sales layer on top of the generic CRM: projects
-- (urbanizaciones), units (lotes/viviendas) with a status lifecycle
-- (disponible → reservado → vendido), reservations ("separaciones")
-- tying one or more units to a contact, and their payment records
-- (voucher upload or online/Culqi-style reference).
--
-- Tenancy / RLS tiers mirror the rest of the schema:
--   - real_estate_projects / real_estate_units: settings-class
--     (any member reads, admin+ writes) — same tier as pipelines,
--     ai_knowledge_documents, whatsapp_config.
--   - reservations / reservation_payments: operational
--     (agent+ writes) — same tier as deals.
--   - reservation_units: pure junction, RLS via parent join
--     (mirrors contact_tags in 017).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- real_estate_projects — one row per urbanización/proyecto.
-- ============================================================
CREATE TABLE IF NOT EXISTS real_estate_projects (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name                  text NOT NULL,
  slug                  text,
  location              text,
  city                  text,
  description           text,
  initial_from          numeric(12,2),
  price_cash            numeric(12,2),
  price_financed        numeric(12,2),
  financing_months      integer,
  monthly_payment       numeric(12,2),
  area_from             numeric(8,2),
  amenities             jsonb NOT NULL DEFAULT '[]'::jsonb,
  cover_image_url       text,
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'sold_out', 'coming_soon')),
  seller_company        text,
  seller_representative text,
  seller_dni            text,
  seller_address        text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS real_estate_projects_account_id_idx
  ON real_estate_projects (account_id);

ALTER TABLE real_estate_projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS real_estate_projects_select ON real_estate_projects;
CREATE POLICY real_estate_projects_select ON real_estate_projects FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS real_estate_projects_insert ON real_estate_projects;
CREATE POLICY real_estate_projects_insert ON real_estate_projects FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS real_estate_projects_update ON real_estate_projects;
CREATE POLICY real_estate_projects_update ON real_estate_projects FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS real_estate_projects_delete ON real_estate_projects;
CREATE POLICY real_estate_projects_delete ON real_estate_projects FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_real_estate_projects_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS real_estate_projects_updated_at ON real_estate_projects;
CREATE TRIGGER real_estate_projects_updated_at
  BEFORE UPDATE ON real_estate_projects
  FOR EACH ROW
  EXECUTE FUNCTION public.update_real_estate_projects_updated_at();

-- ============================================================
-- real_estate_units — lotes/viviendas within a project. account_id
-- is denormalized off the project so RLS and dashboard queries can
-- filter without a join (mirrors ai_knowledge_chunks in 030).
-- ============================================================
CREATE TABLE IF NOT EXISTS real_estate_units (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES real_estate_projects(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code            text NOT NULL,
  manzana         text,
  lote_number     integer,
  area_total      numeric(8,2),
  area_techada    numeric(8,2),
  area_no_techada numeric(8,2),
  rooms           jsonb NOT NULL DEFAULT '[]'::jsonb,
  floors          integer NOT NULL DEFAULT 1,
  height_floor    numeric(4,2),
  height_total    numeric(4,2),
  material        text,
  services        text,
  ventilation     text,
  price           numeric(12,2),
  currency        text NOT NULL DEFAULT 'PEN',
  status          text NOT NULL DEFAULT 'disponible'
                    CHECK (status IN ('disponible', 'reservado', 'vendido')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, code)
);

CREATE INDEX IF NOT EXISTS real_estate_units_account_id_idx
  ON real_estate_units (account_id);
CREATE INDEX IF NOT EXISTS real_estate_units_project_id_idx
  ON real_estate_units (project_id);
CREATE INDEX IF NOT EXISTS real_estate_units_status_idx
  ON real_estate_units (status);

ALTER TABLE real_estate_units ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS real_estate_units_select ON real_estate_units;
CREATE POLICY real_estate_units_select ON real_estate_units FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS real_estate_units_insert ON real_estate_units;
CREATE POLICY real_estate_units_insert ON real_estate_units FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS real_estate_units_update ON real_estate_units;
CREATE POLICY real_estate_units_update ON real_estate_units FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS real_estate_units_delete ON real_estate_units;
CREATE POLICY real_estate_units_delete ON real_estate_units FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_real_estate_units_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS real_estate_units_updated_at ON real_estate_units;
CREATE TRIGGER real_estate_units_updated_at
  BEFORE UPDATE ON real_estate_units
  FOR EACH ROW
  EXECUTE FUNCTION public.update_real_estate_units_updated_at();

-- ============================================================
-- reservations — "separaciones": one or more units tied to a
-- contact, worked by an advisor. Operational tier, mirrors deals.
-- ============================================================
CREATE TABLE IF NOT EXISTS reservations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Nullable on contact delete — history preserved, same pattern as
  -- deals.contact_id (migration 004).
  contact_id     uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- References profiles(id) (not auth.users) — same convention as
  -- deals.assigned_to (migration 002) — so PostgREST can embed
  -- `advisor:profiles(*)` directly without going through auth.users.
  advisor_id     uuid REFERENCES profiles(id) ON DELETE SET NULL,
  total_amount   numeric(12,2) NOT NULL DEFAULT 0,
  currency       text NOT NULL DEFAULT 'PEN',
  payment_method text CHECK (payment_method IN ('voucher', 'online', 'mixed')),
  status         text NOT NULL DEFAULT 'pendiente'
                   CHECK (status IN ('pendiente', 'aprobada', 'rechazada', 'cerrada')),
  notes          text,
  approved_by    uuid REFERENCES profiles(id) ON DELETE SET NULL,
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reservations_account_id_idx
  ON reservations (account_id);
CREATE INDEX IF NOT EXISTS reservations_contact_id_idx
  ON reservations (contact_id);
CREATE INDEX IF NOT EXISTS reservations_status_idx
  ON reservations (status);

ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reservations_select ON reservations;
CREATE POLICY reservations_select ON reservations FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS reservations_insert ON reservations;
CREATE POLICY reservations_insert ON reservations FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS reservations_update ON reservations;
CREATE POLICY reservations_update ON reservations FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS reservations_delete ON reservations;
CREATE POLICY reservations_delete ON reservations FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_reservations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reservations_updated_at ON reservations;
CREATE TRIGGER reservations_updated_at
  BEFORE UPDATE ON reservations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_reservations_updated_at();

-- ============================================================
-- reservation_units — junction for block reservations (2+ lotes in
-- one separación). No own account_id — RLS goes through the parent
-- reservation, same shape as contact_tags (017).
-- ============================================================
CREATE TABLE IF NOT EXISTS reservation_units (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  unit_id        uuid NOT NULL REFERENCES real_estate_units(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reservation_id, unit_id)
);

CREATE INDEX IF NOT EXISTS reservation_units_reservation_id_idx
  ON reservation_units (reservation_id);
CREATE INDEX IF NOT EXISTS reservation_units_unit_id_idx
  ON reservation_units (unit_id);

ALTER TABLE reservation_units ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reservation_units_select ON reservation_units;
CREATE POLICY reservation_units_select ON reservation_units FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.id = reservation_units.reservation_id
        AND is_account_member(r.account_id)
    )
  );

DROP POLICY IF EXISTS reservation_units_insert ON reservation_units;
CREATE POLICY reservation_units_insert ON reservation_units FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.id = reservation_units.reservation_id
        AND is_account_member(r.account_id, 'agent')
    )
  );

DROP POLICY IF EXISTS reservation_units_delete ON reservation_units;
CREATE POLICY reservation_units_delete ON reservation_units FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM reservations r
      WHERE r.id = reservation_units.reservation_id
        AND is_account_member(r.account_id, 'agent')
    )
  );

-- ============================================================
-- reservation_payments — vouchers (manual, reviewed by gerencia) or
-- online/Culqi-style references. account_id denormalized off the
-- reservation for RLS + dashboard queries.
-- ============================================================
CREATE TABLE IF NOT EXISTS reservation_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type           text NOT NULL CHECK (type IN ('voucher', 'culqi', 'transferencia')),
  amount         numeric(12,2) NOT NULL,
  voucher_url    text,
  reference      text,
  status         text NOT NULL DEFAULT 'pendiente'
                   CHECK (status IN ('pendiente', 'aprobado', 'rechazado')),
  reviewed_by    uuid REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reservation_payments_account_id_idx
  ON reservation_payments (account_id);
CREATE INDEX IF NOT EXISTS reservation_payments_reservation_id_idx
  ON reservation_payments (reservation_id);

ALTER TABLE reservation_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reservation_payments_select ON reservation_payments;
CREATE POLICY reservation_payments_select ON reservation_payments FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS reservation_payments_insert ON reservation_payments;
CREATE POLICY reservation_payments_insert ON reservation_payments FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS reservation_payments_update ON reservation_payments;
CREATE POLICY reservation_payments_update ON reservation_payments FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS reservation_payments_delete ON reservation_payments;
CREATE POLICY reservation_payments_delete ON reservation_payments FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- Storage bucket for vouchers/contract uploads. Mirrors chat-media
-- (023): public bucket, account-scoped write RLS matching the first
-- path segment ("account-<uuid>/...").
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'reservation-docs',
  'reservation-docs',
  true,
  16777216, -- 16 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS reservation_docs_select ON storage.objects;
CREATE POLICY reservation_docs_select ON storage.objects FOR SELECT
  USING (bucket_id = 'reservation-docs');

DROP POLICY IF EXISTS reservation_docs_insert ON storage.objects;
CREATE POLICY reservation_docs_insert ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'reservation-docs'
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS reservation_docs_delete ON storage.objects;
CREATE POLICY reservation_docs_delete ON storage.objects FOR DELETE
  USING (
    bucket_id = 'reservation-docs'
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

-- ============================================================
-- Realtime — surface live unit/reservation status changes (e.g. a
-- lot flipping to "reservado" while another advisor is looking at
-- the same project) the same way conversations/messages already do.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'real_estate_units'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE real_estate_units;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'reservations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE reservations;
  END IF;
END $$;
