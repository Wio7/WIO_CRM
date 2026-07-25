-- ============================================================
-- 033_legal_documents.sql — Legal document generator (Anexo 01,
-- Anexo 02, Minuta) for real-estate reservations.
--
-- One row per (reservation, doc_type) — a document is edited
-- in place and re-generated (new PDF, same row) rather than
-- versioned, matching the MVP scope. All form-specific content
-- (buyer data, cónyuge, additional units, cuotas schedule) lives
-- in `data` JSONB rather than dedicated columns on `contacts` /
-- `reservations` — those tables are generic across every business
-- vertical wacrm supports, not just real estate.
--
-- RLS tier: operational, mirrors `reservations` (017/032) — viewer
-- reads, agent+ writes (generates/edits drafts). The "aprobar /
-- listo para firma" transition is gated in the UI via
-- useCan("edit-settings"), the same pattern reservation-detail.tsx
-- already uses for approving separaciones — not modeled at the RLS
-- layer so the role logic isn't duplicated in two places.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS legal_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  doc_type       text NOT NULL CHECK (doc_type IN ('anexo_01', 'anexo_02', 'minuta')),
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'borrador'
                   CHECK (status IN ('borrador', 'pendiente', 'aprobado', 'rechazado', 'listo_para_firma')),
  pdf_url        text,
  created_by     uuid REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_by    uuid REFERENCES profiles(id) ON DELETE SET NULL,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reservation_id, doc_type)
);

CREATE INDEX IF NOT EXISTS legal_documents_account_id_idx
  ON legal_documents (account_id);
CREATE INDEX IF NOT EXISTS legal_documents_reservation_id_idx
  ON legal_documents (reservation_id);

ALTER TABLE legal_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS legal_documents_select ON legal_documents;
CREATE POLICY legal_documents_select ON legal_documents FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS legal_documents_insert ON legal_documents;
CREATE POLICY legal_documents_insert ON legal_documents FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS legal_documents_update ON legal_documents;
CREATE POLICY legal_documents_update ON legal_documents FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS legal_documents_delete ON legal_documents;
CREATE POLICY legal_documents_delete ON legal_documents FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_legal_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS legal_documents_updated_at ON legal_documents;
CREATE TRIGGER legal_documents_updated_at
  BEFORE UPDATE ON legal_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.update_legal_documents_updated_at();

-- Realtime — so the approval workflow (asesor's screen unlocking the
-- moment gerencia marks "listo_para_firma") updates live, same as
-- reservations/real_estate_units already do (032).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'legal_documents'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE legal_documents;
  END IF;
END $$;
