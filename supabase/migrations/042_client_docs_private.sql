-- ============================================================
-- 042_client_docs_private.sql — A private home for vouchers and contracts
--
-- Until now vouchers, Anexos and Minutas shared `reservation-docs` with
-- project cover images, and that bucket is PUBLIC: anyone holding (or
-- guessing) the URL `…/reservation-docs/account-<uuid>/<timestamp>-<name>`
-- could read a client's payment slip or a signed contract without logging
-- in. It also defeated the download lock on the Minuta
-- (/api/legal-documents/[id]/download), since the public URL bypasses it.
--
-- Project images are meant to be public, so instead of flipping that
-- bucket we add a private one next to it:
--
--   reservation-docs  public   project covers and gallery images
--   client-docs       PRIVATE  vouchers, Anexos, Minutas, client papers
--
-- Reads happen through short-lived signed URLs minted by the server, so
-- the app keeps working without exposing a permanent public link.
-- Access follows the same account-scoped path convention as every other
-- bucket here: `account-<account_id>/…`, checked against the caller's
-- membership. 'agent' or higher, so read-only staff and the clients of
-- migration 041 never see another client's papers.
--
-- Old rows keep full public URLs in `reservation_payments.voucher_url`
-- and `legal_documents.pdf_url`; the code reads both shapes, so this
-- migration needs no data backfill. Files already uploaded stay in the
-- public bucket — move them by hand if that history matters.
--
-- Idempotent — safe to re-run.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'client-docs',
  'client-docs',
  false,
  16777216, -- 16 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Reading: members of the owning account, agent or higher.
DROP POLICY IF EXISTS client_docs_select ON storage.objects;
CREATE POLICY client_docs_select ON storage.objects FOR SELECT
  USING (
    bucket_id = 'client-docs'
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
        AND is_account_member(p.account_id, 'agent')
    )
  );

DROP POLICY IF EXISTS client_docs_insert ON storage.objects;
CREATE POLICY client_docs_insert ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'client-docs'
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
        AND is_account_member(p.account_id, 'agent')
    )
  );

-- Deleting a voucher or a contract is an administrative act.
DROP POLICY IF EXISTS client_docs_delete ON storage.objects;
CREATE POLICY client_docs_delete ON storage.objects FOR DELETE
  USING (
    bucket_id = 'client-docs'
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
        AND is_account_member(p.account_id, 'admin')
    )
  );

-- ============================================================
-- The public bucket keeps serving project images, but it should never
-- have accepted a contract: narrow what it takes to images only.
-- ============================================================
UPDATE storage.buckets
   SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
 WHERE id = 'reservation-docs';
