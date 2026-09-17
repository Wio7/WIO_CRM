-- ============================================================
-- 047_installment_payment_detail.sql — how a cuota was paid
--
-- 043 says a cuota is paid, when, and for how much. What it does not say
-- is HOW: cash at the office, a Yape, a transfer, and with which
-- operation number. Collections calls live on that detail — "ya pagué,
-- operación 884512" is the first thing a client says — and today the
-- advisor has nowhere to type it, so it ends up in a notebook again.
--
-- Nothing here changes what `payment_plan_balances` computes: these are
-- descriptive columns beside the payment, not new states.
--
-- "En revisión" deliberately has NO status of its own. A cuota whose
-- voucher the client uploaded but nobody approved yet is
-- `status = 'pendiente' AND voucher_path IS NOT NULL`: it keeps counting
-- as owed (and as overdue if it is late) until someone approves it, which
-- is exactly the truth. A fourth status would have silently removed it
-- from `pending_amount` the moment the client uploaded a photo.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE installments
  -- Free text on purpose: the office already writes "Yape", "BCP",
  -- "efectivo" in its notebook, and a CHECK list would be wrong by the
  -- next bank. The UI offers the usual ones and lets them type others.
  ADD COLUMN IF NOT EXISTS paid_method    text,
  -- Operation / voucher number, as printed on the receipt.
  ADD COLUMN IF NOT EXISTS paid_reference text,
  -- Object path inside the PRIVATE `client-docs` bucket (042), never a
  -- public URL: downloads are signed, like every other client document.
  ADD COLUMN IF NOT EXISTS voucher_path   text,
  ADD COLUMN IF NOT EXISTS notes          text,
  -- Who registered the payment, for the same reason reservations track
  -- their reviewer: money moved, someone answers for it.
  ADD COLUMN IF NOT EXISTS registered_by  uuid REFERENCES profiles(id) ON DELETE SET NULL;

-- The collections inbox: vouchers waiting for someone to approve them.
CREATE INDEX IF NOT EXISTS idx_installments_voucher_pending
  ON installments(account_id, due_date)
  WHERE status = 'pendiente' AND voucher_path IS NOT NULL;

COMMENT ON COLUMN installments.voucher_path IS
  'Ruta del voucher en el bucket privado client-docs (042). Con status pendiente significa "en revisión".';
