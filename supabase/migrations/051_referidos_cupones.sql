-- ============================================================
-- 051_referidos_cupones.sql — Referidos y cupones (E8)
--
-- Lo que se decidió (16-09): los descuentos son CUPONES DE UN SOLO USO
-- atados a un DNI. Y un cliente que trae a otro gana algo.
--
--   contacts.referral_code  el código de cada cliente para compartir
--                           (se crea la primera vez que lo pide).
--   referrals               quién trajo a quién. Nace 'registrado' cuando
--                           el nuevo entra a la app con el enlace; pasa a
--                           'compro' solo, cuando al referido le crean su
--                           plan de cuotas; y a 'premiado' cuando el
--                           equipo le da el cupón a quien lo trajo.
--   coupons                 el cupón: un código, un DNI, un valor (monto o
--                           porcentaje) y un solo uso. Lo usa el equipo al
--                           armar la separación o el plan, no el cliente.
--
-- El premio NO es automático: cuánto vale traer a alguien lo decide el
-- equipo en cada caso (pantalla Cupones del CRM). La base sólo avisa.
--
-- Idempotente — se puede volver a correr.
-- ============================================================

-- ============================================================
-- 1. Código de referido
-- ============================================================
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS referral_code text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_referral_code
  ON contacts(account_id, referral_code)
  WHERE referral_code IS NOT NULL;

-- ============================================================
-- 2. Referidos
-- ============================================================
CREATE TABLE IF NOT EXISTS referrals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  referrer_contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Un contacto sólo puede haber sido traído por una persona.
  referred_contact_id  uuid NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  status               text NOT NULL DEFAULT 'registrado'
                         CHECK (status IN ('registrado', 'compro', 'premiado', 'anulado')),
  converted_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (referrer_contact_id <> referred_contact_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_contact_id);
CREATE INDEX IF NOT EXISTS idx_referrals_account ON referrals(account_id, status);

-- ============================================================
-- 3. Cupones
-- ============================================================
CREATE TABLE IF NOT EXISTS coupons (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Lo que se dicta por teléfono: corto, sin letras que se confundan.
  code         text NOT NULL,
  -- El DNI manda: el cupón es de esa persona aunque cambie de celular.
  dni          text NOT NULL CHECK (dni ~ '^[0-9]{8,12}$'),
  contact_id   uuid REFERENCES contacts(id) ON DELETE SET NULL,
  kind         text NOT NULL CHECK (kind IN ('monto', 'porcentaje')),
  value        numeric(12,2) NOT NULL CHECK (value > 0),
  currency     text NOT NULL DEFAULT 'PEN',
  description  text,
  origin       text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'referido', 'promocion')),
  referral_id  uuid REFERENCES referrals(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'activo'
                 CHECK (status IN ('activo', 'usado', 'anulado')),
  expires_at   date,
  used_at      timestamptz,
  used_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  used_note    text,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'porcentaje' OR value <= 100),
  UNIQUE (account_id, code)
);

CREATE INDEX IF NOT EXISTS idx_coupons_dni ON coupons(account_id, dni);
CREATE INDEX IF NOT EXISTS idx_coupons_status ON coupons(account_id, status);

DROP TRIGGER IF EXISTS coupons_updated_at ON coupons;
CREATE TRIGGER coupons_updated_at
  BEFORE UPDATE ON coupons
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 4. RLS — como el resto: lee cualquier miembro, escribe desde asesor,
--    borra el administrador. El cliente entra por el servidor.
-- ============================================================
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS referrals_select ON referrals;
CREATE POLICY referrals_select ON referrals FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS referrals_write ON referrals;
CREATE POLICY referrals_write ON referrals FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS coupons_select ON coupons;
CREATE POLICY coupons_select ON coupons FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS coupons_insert ON coupons;
CREATE POLICY coupons_insert ON coupons FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS coupons_update ON coupons;
CREATE POLICY coupons_update ON coupons FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS coupons_delete ON coupons;
CREATE POLICY coupons_delete ON coupons FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- 5. El referido compró: al crearle su plan de cuotas, su referido pasa
--    a 'compro'. El premio lo decide el equipo.
-- ============================================================
CREATE OR REPLACE FUNCTION public.referral_on_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.contact_id IS NOT NULL AND NEW.status IN ('activo', 'pagado') THEN
    UPDATE referrals
    SET status = 'compro', converted_at = now()
    WHERE referred_contact_id = NEW.contact_id
      AND status = 'registrado';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_plans_referral ON payment_plans;
CREATE TRIGGER payment_plans_referral
  AFTER INSERT OR UPDATE OF status, contact_id ON payment_plans
  FOR EACH ROW EXECUTE FUNCTION public.referral_on_plan();

COMMENT ON TABLE referrals IS 'Quién trajo a quién: registrado → compro (automático) → premiado (lo decide el equipo).';
COMMENT ON TABLE coupons IS 'Cupones de un solo uso atados a un DNI.';
