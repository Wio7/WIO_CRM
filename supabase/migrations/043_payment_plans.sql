-- ============================================================
-- 043_payment_plans.sql — What each client owes, and when
--
-- The CRM already tracks a RESERVATION (a client holds a unit) and the
-- vouchers paid against it, but nothing says "70 instalments of S/ 286,
-- the next one due on the 5th". Collections live in someone's notebook,
-- and the client portal can't answer the only question a client asks:
-- how much do I owe and when.
--
--   payment_plans  the deal: price, down payment, how many instalments
--   installments   one row per month: amount, due date, paid or not
--
-- Design notes
--   · "Overdue" is NOT stored. A stored flag needs a nightly job and goes
--     stale the moment it doesn't run; overdue is simply
--     `status = 'pendiente' AND due_date < current_date`, which is always
--     true at read time. The partial index below keeps that cheap.
--   · An instalment points at the `reservation_payments` row that paid it,
--     so the voucher the client uploaded and the instalment it settles are
--     one chain, with no double bookkeeping.
--   · A plan may exist without a reservation (a sale closed before the CRM
--     had one) and without a unit (a client paying for something not yet
--     in the catalogue), so both links are nullable.
--   · Amounts are numeric(12,2) like every other money column here, and
--     the currency defaults to PEN as in `real_estate_units`.
--
-- Access follows the rest of the CRM: members of the owning account,
-- 'agent' or higher, can read and write; deleting is an admin act. After
-- 041 a viewer of a client account is not a member, so clients reach
-- their own plan through the server, never through these policies.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. The plan
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_plans (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Nullable on contact delete, same as reservations.contact_id: the
  -- history of what was owed outlives the contact row.
  contact_id         uuid REFERENCES contacts(id) ON DELETE SET NULL,
  unit_id            uuid REFERENCES real_estate_units(id) ON DELETE SET NULL,
  reservation_id     uuid REFERENCES reservations(id) ON DELETE SET NULL,
  currency           text NOT NULL DEFAULT 'PEN',
  total_amount       numeric(12,2) NOT NULL,
  down_payment       numeric(12,2) NOT NULL DEFAULT 0,
  installments_count integer NOT NULL CHECK (installments_count > 0),
  monthly_amount     numeric(12,2) NOT NULL,
  -- Day of the month the client pays. Kept beside the dates so a plan
  -- can be regenerated without guessing the office's convention.
  due_day            integer CHECK (due_day BETWEEN 1 AND 31),
  first_due_date     date NOT NULL,
  notes              text,
  status             text NOT NULL DEFAULT 'activo'
                       CHECK (status IN ('activo', 'pagado', 'suspendido', 'cancelado')),
  created_by         uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_plans_account ON payment_plans(account_id);
CREATE INDEX IF NOT EXISTS idx_payment_plans_contact ON payment_plans(contact_id);

-- ============================================================
-- 2. The instalments
-- ============================================================
CREATE TABLE IF NOT EXISTS installments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id     uuid NOT NULL REFERENCES payment_plans(id) ON DELETE CASCADE,
  -- Denormalised so every RLS policy and dashboard query filters by
  -- account without joining the plan, exactly like reservation_payments.
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  number      integer NOT NULL CHECK (number > 0),
  amount      numeric(12,2) NOT NULL,
  due_date    date NOT NULL,
  status      text NOT NULL DEFAULT 'pendiente'
                CHECK (status IN ('pendiente', 'pagada', 'condonada')),
  -- The voucher that settled it (reservation_payments row). Kept nullable
  -- for cash paid at the office, which has no voucher to upload.
  payment_id  uuid REFERENCES reservation_payments(id) ON DELETE SET NULL,
  paid_at     timestamptz,
  paid_amount numeric(12,2),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, number)
);

CREATE INDEX IF NOT EXISTS idx_installments_plan ON installments(plan_id, number);

-- "What's overdue, and what falls due next" — the two questions the
-- dashboard, the reminders and the client portal all ask.
CREATE INDEX IF NOT EXISTS idx_installments_pending_by_date
  ON installments(account_id, due_date)
  WHERE status = 'pendiente';

-- ============================================================
-- 3. Row level security — same shape as reservations (032)
-- ============================================================
ALTER TABLE payment_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE installments  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_plans_select ON payment_plans;
CREATE POLICY payment_plans_select ON payment_plans FOR SELECT
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS payment_plans_insert ON payment_plans;
CREATE POLICY payment_plans_insert ON payment_plans FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS payment_plans_update ON payment_plans;
CREATE POLICY payment_plans_update ON payment_plans FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS payment_plans_delete ON payment_plans;
CREATE POLICY payment_plans_delete ON payment_plans FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS installments_select ON installments;
CREATE POLICY installments_select ON installments FOR SELECT
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS installments_insert ON installments;
CREATE POLICY installments_insert ON installments FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS installments_update ON installments;
CREATE POLICY installments_update ON installments FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS installments_delete ON installments;
CREATE POLICY installments_delete ON installments FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- 4. The balance, computed — never written by hand
--
-- One row per plan with what's paid, what's left, what's overdue and the
-- next due date. A view (not a materialised one) so it can never be
-- stale: the numbers a client sees are the numbers in the table.
--
-- `security_invoker` matters here: without it the view would run with its
-- owner's rights and hand every account's balances to any caller. With
-- it, the policies above apply to whoever queries it. (Postgres 15+,
-- which is what Supabase runs.)
-- ============================================================
CREATE OR REPLACE VIEW payment_plan_balances
WITH (security_invoker = true) AS
SELECT
  p.id                AS plan_id,
  p.account_id,
  p.contact_id,
  p.currency,
  p.total_amount,
  p.down_payment,
  p.installments_count,
  p.monthly_amount,
  p.status,
  -- `paid_amount` is optional (cash at the office often isn't typed in),
  -- so a paid instalment without it falls back to what it was worth.
  -- Summing the raw column would quietly under-report what the client paid.
  COALESCE(SUM(COALESCE(i.paid_amount, i.amount)) FILTER (WHERE i.status = 'pagada'), 0) AS paid_amount,
  COUNT(i.id) FILTER (WHERE i.status = 'pagada')                              AS paid_count,
  COALESCE(SUM(i.amount) FILTER (WHERE i.status = 'pendiente'), 0)            AS pending_amount,
  COUNT(i.id) FILTER (WHERE i.status = 'pendiente')                           AS pending_count,
  COUNT(i.id) FILTER (WHERE i.status = 'pendiente' AND i.due_date < current_date) AS overdue_count,
  COALESCE(SUM(i.amount) FILTER (WHERE i.status = 'pendiente' AND i.due_date < current_date), 0) AS overdue_amount,
  MIN(i.due_date) FILTER (WHERE i.status = 'pendiente')                       AS next_due_date
FROM payment_plans p
LEFT JOIN installments i ON i.plan_id = p.id
GROUP BY p.id;

-- ============================================================
-- 5. Keep `updated_at` honest — reusing the trigger function every
--    other table here already uses (migration 001).
-- ============================================================
DROP TRIGGER IF EXISTS payment_plans_updated_at ON payment_plans;
CREATE TRIGGER payment_plans_updated_at
  BEFORE UPDATE ON payment_plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS installments_updated_at ON installments;
CREATE TRIGGER installments_updated_at
  BEFORE UPDATE ON installments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
