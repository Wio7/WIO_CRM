-- ============================================================
-- 081_account_business.sql — Negocio y apps de cada cuenta
--
-- El panel Cuentas (super admin) agrupa las cuentas por negocio:
-- Golden Habitat, Juris Pro, Broker Home... Hasta ahora lo adivinaba
-- por el nombre de la cuenta. Con estas dos columnas se administra
-- desde el panel:
--
--   accounts.parent_account_id  negocio del que cuelga esta cuenta
--                               (null = la cuenta ES un negocio)
--   accounts.apps               en un negocio: su familia de apps
--                               (ej. Golden App, Golden Legal, Golden Caja);
--                               en una cuenta que cuelga: las apps que usa.
--
-- Un solo nivel: un negocio no cuelga de otro, y una cuenta no puede
-- colgar de una que ya cuelga de otra.
--
-- Solo el super admin (o service_role / SQL editor) puede cambiarlas,
-- igual que disabled_modules (066): el policy accounts_update deja
-- editar la cuenta a sus propios admins.
--
-- Idempotente.
-- ============================================================

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS parent_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS apps TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_parent_not_self;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_parent_not_self
  CHECK (parent_account_id IS NULL OR parent_account_id <> id);

CREATE INDEX IF NOT EXISTS idx_accounts_parent ON public.accounts(parent_account_id);

CREATE OR REPLACE FUNCTION public.guard_account_business()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.parent_account_id IS DISTINCT FROM OLD.parent_account_id
      OR NEW.apps IS DISTINCT FROM OLD.apps)
     AND auth.uid() IS NOT NULL
     AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Solo el super admin puede cambiar el negocio o las apps de la cuenta';
  END IF;

  IF NEW.parent_account_id IS NOT NULL THEN
    -- El negocio elegido no puede colgar de otro.
    IF EXISTS (
      SELECT 1 FROM public.accounts
      WHERE id = NEW.parent_account_id AND parent_account_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Esa cuenta ya pertenece a otro negocio; elige el negocio principal';
    END IF;
    -- Y esta cuenta no puede ser negocio de otras a la vez.
    IF EXISTS (
      SELECT 1 FROM public.accounts WHERE parent_account_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'Esta cuenta tiene cuentas dentro; primero muevelas';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounts_guard_business ON public.accounts;
CREATE TRIGGER accounts_guard_business
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.guard_account_business();

-- Orden inicial, como lo dejo Bryce el 2026-11-05. Si un id no existe,
-- el UPDATE no toca nada.
UPDATE public.accounts SET apps = ARRAY['Golden App (ventas)', 'Golden Caja', 'Golden Legal']
  WHERE id = 'd74b5dfd-2999-4e2c-9a0e-10b3d540898b' AND apps = ARRAY[]::TEXT[];
UPDATE public.accounts SET parent_account_id = 'd74b5dfd-2999-4e2c-9a0e-10b3d540898b'
  WHERE id IN (
    'd0ebd3fb-27f6-49ac-8ee3-92135080b1fc',
    'd5997240-e461-4520-add4-94d22d551a37',
    'f99589e2-3e80-4899-a467-6326b04c7203',
    '0a62fd89-21d8-4743-a13d-b9e1bbcf9434'
  ) AND parent_account_id IS NULL;

UPDATE public.accounts SET apps = ARRAY['Juris Pro App']
  WHERE id = '948979bd-66d3-416f-a569-5f8369ad0590' AND apps = ARRAY[]::TEXT[];
UPDATE public.accounts SET parent_account_id = '948979bd-66d3-416f-a569-5f8369ad0590',
                           apps = ARRAY['Juris Pro App']
  WHERE id = '4ec269db-fa19-4994-9aa3-90f29285037e' AND parent_account_id IS NULL;
