-- ============================================================
-- 092_area_administracion.sql — Área "Administración"
--
-- Casos: supabase/tests/092_casos.sql (correr DESPUÉS de aplicar esta).
-- Requiere: 084 (can_access_module), 085/089 (set_member_area con 'promueve')
-- y 087_caja_proyecto_rubro (cash_panel_access).
--
-- Administración lleva la Caja Ica (conciliación del estado de cuenta, abonos,
-- pagos por validar) y todo lo que tenga que ver con eso. Contabilidad sigue
-- siendo un área aparte. Datos: Administración puede LO MISMO que Contabilidad
-- y nada más (ni legal, ni postventa, ni gerencia, ni ventas).
--
-- Qué cambia:
--   1. 'administracion' en profiles.area (profiles_area_check, vigente = 089).
--   2. set_member_area: copia de la de 089 (la vigente) + 'administracion'.
--   3. can_access_module: copia de la de 084 (única definición en el repo) con
--      'administracion' junto a 'contabilidad' en los módulos 'cobranzas'
--      (pagos, gestiones, avisos, abonos; confirmar pagos) y 'cronograma'
--      (planes y cuotas). 'legal' y 'ventas' no cambian.
--   4. cash_panel_access: copia de la de 087 con 'administracion' junto a
--      'contabilidad' (panel de gerencia de la caja chica).
--
-- Funciones que reemplaza (comprobar su huella md5 en producción ANTES de
-- aplicar; la base real se desvía de las migraciones del repo):
--   public.set_member_area(uuid, text)
--   public.can_access_module(uuid, text)
--   public.cash_panel_access(uuid)
-- No toca policies, vistas ni tablas: todas leen can_access_module /
-- cash_panel_access, así que Administración entra por ahí. No toca
-- is_owner_or_gerencia (Administración NO es gerencia: no abona a capital ni
-- crea códigos Promueve), can_manage_schedule ni postventa_has_access.
--
-- Idempotente — se puede volver a correr.
-- ============================================================
BEGIN;

-- ============================================================
-- 1. Área
-- ============================================================
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_area_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_area_check
  CHECK (area IS NULL OR area IN ('marketing', 'legal', 'cobranzas', 'ventas', 'gerencia', 'contabilidad', 'tecnica', 'promueve', 'administracion'));

-- ============================================================
-- 2. set_member_area (089 + 'administracion'; el resto igual)
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_member_area(
  p_user_id UUID,
  p_area TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_account, v_caller_role
  FROM profiles WHERE user_id = auth.uid();

  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_area IS NOT NULL
     AND p_area NOT IN ('marketing', 'legal', 'cobranzas', 'ventas', 'gerencia', 'contabilidad', 'tecnica', 'promueve', 'administracion') THEN
    RAISE EXCEPTION 'Unknown area: %', p_area USING ERRCODE = '22023';
  END IF;

  SELECT account_role INTO v_target_role
  FROM profiles
  WHERE user_id = p_user_id AND account_id = v_account;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '22023';
  END IF;

  IF v_caller_role = 'admin' AND v_target_role IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only an owner can change an admin''s area'
      USING ERRCODE = '42501';
  END IF;

  IF v_caller_role <> 'owner' AND p_area = 'gerencia' THEN
    RAISE EXCEPTION 'Only an owner can grant the gerencia area'
      USING ERRCODE = '42501';
  END IF;

  IF v_caller_role <> 'owner'
     AND (SELECT area FROM profiles WHERE user_id = p_user_id AND account_id = v_account) = 'gerencia' THEN
    RAISE EXCEPTION 'Only an owner can change a gerencia member''s area'
      USING ERRCODE = '42501';
  END IF;

  -- Un Promueve es siempre agente externo: no se le pone esta área a un
  -- dueño ni a un administrador (quedaría con el rol alto y sin acceso).
  IF p_area = 'promueve' AND v_target_role IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Promueve solo se asigna a agentes' USING ERRCODE = '22023';
  END IF;

  UPDATE profiles
     SET area = p_area,
         area_set_by = (SELECT id FROM profiles WHERE user_id = auth.uid()),
         area_set_at = NOW()
   WHERE user_id = p_user_id AND account_id = v_account;
END;
$$;

ALTER FUNCTION public.set_member_area(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_area(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_area(UUID, TEXT) TO authenticated;

-- ============================================================
-- 3. Datos de pagos y cronograma: Administración como Contabilidad
-- (084; 'administracion' en 'cobranzas' y 'cronograma')
-- ============================================================
CREATE OR REPLACE FUNCTION public.can_access_module(p_account_id uuid, p_module text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL OR p_account_id IS NULL THEN false
    WHEN public.has_full_access(p_account_id) THEN true
    WHEN NOT public.is_account_member(p_account_id, 'agent') THEN false
    ELSE EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.user_id = auth.uid()
         AND p.account_id = p_account_id
         AND CASE p_module
               WHEN 'cobranzas'  THEN p.area IN ('cobranzas', 'contabilidad', 'administracion', 'gerencia')
               WHEN 'cronograma' THEN p.area IN ('cobranzas', 'contabilidad', 'administracion', 'gerencia', 'legal')
               WHEN 'legal'      THEN p.area = 'legal'
               WHEN 'ventas'     THEN p.area IS NULL OR p.area = 'ventas'
               ELSE false
             END
    ) OR EXISTS (
      SELECT 1 FROM public.account_module_members m
       WHERE m.account_id = p_account_id
         AND m.user_id = auth.uid()
         AND (m.module_key = p_module
              OR (p_module = 'cronograma' AND m.module_key IN ('cobranzas', 'legal')))
    )
  END;
$$;
ALTER FUNCTION public.can_access_module(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_access_module(uuid, text)  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_module(uuid, text) TO anon, authenticated, service_role;

-- ============================================================
-- 4. Panel de gerencia de la caja chica (087 + 'administracion')
-- ============================================================
CREATE OR REPLACE FUNCTION public.cash_panel_access(p_account uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT auth.uid() IS NOT NULL AND p_account IS NOT NULL AND (
    public.is_owner_or_gerencia(p_account)
    OR (public.is_account_member(p_account, 'agent') AND EXISTS (
          SELECT 1 FROM public.profiles p
           WHERE p.user_id = auth.uid() AND p.account_id = p_account AND p.area IN ('contabilidad', 'administracion')))
    OR EXISTS (SELECT 1 FROM public.cash_companies c
                WHERE c.account_id = p_account AND public.cash_company_role(c.id) = 'owner'));
$$;

COMMIT;

-- PostgREST lee el esquema nuevo sin reiniciar.
NOTIFY pgrst, 'reload schema';
