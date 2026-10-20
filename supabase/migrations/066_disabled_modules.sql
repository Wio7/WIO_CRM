-- ============================================================
-- 066_disabled_modules.sql — Módulos apagados por cuenta
--
-- Lista de rutas del dashboard que una cuenta NO usa (p. ej.
-- '/coupons', '/dialer'). El sidebar las oculta y el shell bloquea
-- la URL directa. Vacío = la cuenta ve todo (comportamiento actual).
--
-- Solo el super admin (o service_role / SQL editor) puede cambiarla:
-- el policy accounts_update deja editar la cuenta a sus admins, y sin
-- este trigger un admin podría volver a encender lo que le apagamos.
--
-- Idempotente.
-- ============================================================

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS disabled_modules TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE OR REPLACE FUNCTION public.guard_disabled_modules()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.disabled_modules IS DISTINCT FROM OLD.disabled_modules
     AND auth.uid() IS NOT NULL
     AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Solo el super admin puede cambiar los módulos de la cuenta';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounts_guard_disabled_modules ON public.accounts;
CREATE TRIGGER accounts_guard_disabled_modules
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.guard_disabled_modules();

-- Ejemplo (Julio, inmobiliaria con lotes): apagar lo que no usa.
-- UPDATE public.accounts
--    SET disabled_modules = ARRAY['/coupons','/dialer','/calls','/flows']
--  WHERE id = '<account_id_de_julio>';
