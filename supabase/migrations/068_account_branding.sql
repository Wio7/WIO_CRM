-- Marca opcional por cuenta. Idempotente; aplicar manualmente.
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS brand_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS logo_url TEXT NULL;

-- Trigger independiente: conserva intacta la protección de la migración 066.
CREATE OR REPLACE FUNCTION public.guard_account_branding()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.brand_name IS DISTINCT FROM OLD.brand_name
      OR NEW.logo_url IS DISTINCT FROM OLD.logo_url)
     AND auth.uid() IS NOT NULL
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Solo el super admin puede cambiar la marca de la cuenta';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounts_guard_branding ON public.accounts;
CREATE TRIGGER accounts_guard_branding
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.guard_account_branding();

-- Ejemplo: confirmar primero el UUID de la cuenta de Julio.
-- UPDATE public.accounts
-- SET brand_name = 'Broker Home', logo_url = '/brands/broker-home.png'
-- WHERE id = '<account_id_de_julio>'::uuid;
