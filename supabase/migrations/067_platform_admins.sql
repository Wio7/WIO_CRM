-- ============================================================
-- 067_platform_admins.sql — Superadmin: pertenencia a una cuenta
--
-- Antes de aplicar, en el SQL Editor (ambos usuarios YA existen; no hay
-- que crear ni renombrar nada en Auth). Mover el perfil del superadmin
-- a Aurex para que su casa sea la agencia y no una cuenta de cliente:
--
--   UPDATE public.profiles
--      SET account_id = '225298bc-5082-437c-a00f-f254e2141ed9',  -- Aurex
--          account_role = 'owner'
--    WHERE user_id = 'c5cbf137-b635-43c4-bee4-953016c342d1';     -- brycebueno15@gmail.com
--
-- La siembra de abajo toma de ahí home_account_id, así que este UPDATE
-- va primero. Golden Habitat conserva a escalante_2010@hotmail.com como
-- dueño residente. wiocompany7@gmail.com deja de ser superadmin: el
-- bypass global desaparece y solo manda quien esté en platform_admins.
--
-- Idempotente. La siembra no modifica una casa ya registrada.
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.platform_admins (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  home_account_id UUID NOT NULL REFERENCES public.accounts(id),
  home_account_role public.account_role_enum NOT NULL DEFAULT 'owner',
  visiting_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.platform_admin_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Conservar el identificador histórico aunque se elimine la cuenta.
  account_id UUID NOT NULL,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  exited_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_admin_audit_open_user
  ON public.platform_admin_audit(user_id) WHERE exited_at IS NULL;

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_admin_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_admins, public.platform_admin_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.platform_admins, public.platform_admin_audit TO authenticated;

DROP POLICY IF EXISTS platform_admins_select ON public.platform_admins;
CREATE POLICY platform_admins_select ON public.platform_admins FOR SELECT TO authenticated
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS platform_admin_audit_select ON public.platform_admin_audit;
CREATE POLICY platform_admin_audit_select ON public.platform_admin_audit FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.is_super_admin());

INSERT INTO public.platform_admins (user_id, home_account_id, home_account_role)
SELECT p.user_id, p.account_id, p.account_role
FROM public.profiles p JOIN auth.users u ON u.id = p.user_id
WHERE lower(u.email) = 'brycebueno15@gmail.com'
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid());
$$;
ALTER FUNCTION public.is_super_admin() OWNER TO postgres;

-- Mismo criterio de 041, sin el bypass global por correo.
CREATE OR REPLACE FUNCTION public.is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    JOIN public.accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND (a.status = 'active' OR public.is_super_admin())
      AND NOT (p.account_role = 'viewer' AND a.viewers_are_clients)
      AND CASE p.account_role
            WHEN 'owner' THEN 4 WHEN 'admin' THEN 3
            WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1
          END >= CASE min_role
            WHEN 'owner' THEN 4 WHEN 'admin' THEN 3
            WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1
          END
  );
$$;
ALTER FUNCTION public.is_account_member(UUID, account_role_enum) OWNER TO postgres;

DROP POLICY IF EXISTS accounts_select ON public.accounts;
CREATE POLICY accounts_select ON public.accounts FOR SELECT
  USING (public.is_account_member(id) OR public.is_super_admin());
DROP POLICY IF EXISTS accounts_update ON public.accounts;
CREATE POLICY accounts_update ON public.accounts FOR UPDATE
  USING (public.is_account_member(id, 'admin') OR public.is_super_admin())
  WITH CHECK (public.is_account_member(id, 'admin') OR public.is_super_admin());
DROP POLICY IF EXISTS accounts_delete ON public.accounts;
CREATE POLICY accounts_delete ON public.accounts FOR DELETE
  USING (public.is_super_admin());

DROP POLICY IF EXISTS contacts_select ON public.contacts;
CREATE POLICY contacts_select ON public.contacts FOR SELECT
  USING (
    public.is_account_member(account_id, 'admin')
    OR (public.is_account_member(account_id, 'viewer') AND (
      user_id = auth.uid() OR EXISTS (
        SELECT 1 FROM public.conversations c
        WHERE c.contact_id = contacts.id AND c.assigned_agent_id = auth.uid()
      )
    ))
  );
DROP POLICY IF EXISTS contacts_update ON public.contacts;
CREATE POLICY contacts_update ON public.contacts FOR UPDATE
  USING (public.is_account_member(account_id, 'admin')
    OR (public.is_account_member(account_id, 'agent') AND user_id = auth.uid()))
  WITH CHECK (public.is_account_member(account_id, 'admin')
    OR (public.is_account_member(account_id, 'agent') AND user_id = auth.uid()));
DROP POLICY IF EXISTS contacts_delete ON public.contacts;
CREATE POLICY contacts_delete ON public.contacts FOR DELETE
  USING (public.is_account_member(account_id, 'admin'));
-- No reemplazar las políticas de conversations: mantienen el aislamiento de 039.

CREATE OR REPLACE FUNCTION public.platform_admin_enter_account(p_account_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- Serializar cambios del mismo usuario, incluso desde dos dispositivos.
  PERFORM 1 FROM public.platform_admins WHERE user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Requiere superadmin' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.accounts WHERE id = p_account_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cuenta no encontrada' USING ERRCODE = '22023';
  END IF;
  UPDATE public.profiles SET account_id = p_account_id, account_role = 'owner'
    WHERE user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Perfil no encontrado' USING ERRCODE = '22023';
  END IF;
  UPDATE public.platform_admins SET visiting_account_id = p_account_id, updated_at = now()
    WHERE user_id = auth.uid();
  UPDATE public.platform_admin_audit SET exited_at = now()
    WHERE user_id = auth.uid() AND exited_at IS NULL;
  INSERT INTO public.platform_admin_audit(user_id, account_id)
    VALUES (auth.uid(), p_account_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_admin_exit_account()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_admin public.platform_admins%ROWTYPE;
BEGIN
  SELECT * INTO v_admin FROM public.platform_admins
    WHERE user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Requiere superadmin' USING ERRCODE = '42501';
  END IF;
  UPDATE public.profiles
    SET account_id = v_admin.home_account_id, account_role = v_admin.home_account_role
    WHERE user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Perfil no encontrado' USING ERRCODE = '22023';
  END IF;
  UPDATE public.platform_admins SET visiting_account_id = NULL, updated_at = now()
    WHERE user_id = auth.uid();
  UPDATE public.platform_admin_audit SET exited_at = now()
    WHERE user_id = auth.uid() AND exited_at IS NULL;
END;
$$;

ALTER FUNCTION public.platform_admin_enter_account(UUID) OWNER TO postgres;
ALTER FUNCTION public.platform_admin_exit_account() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_admin_enter_account(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_admin_exit_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_admin_enter_account(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_admin_exit_account() TO authenticated;

-- La política profiles_update permite editar el perfil propio. Impedir que
-- esa vía cambie directamente la pertenencia; las RPC SECURITY DEFINER de
-- equipo/invitaciones y las de arriba siguen ejecutándose como postgres.
CREATE OR REPLACE FUNCTION public.guard_profile_account_membership()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'La pertenencia se crea mediante una función autorizada' USING ERRCODE = '42501';
    ELSIF NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.account_role IS DISTINCT FROM OLD.account_role
       OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'La pertenencia se cambia mediante una función autorizada' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_profile_account_membership ON public.profiles;
CREATE TRIGGER guard_profile_account_membership BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_account_membership();

-- Evitar que DELETE CASCADE destruya el perfil mientras está de visita.
-- La FK home_account_id ya protege la casa, incluso desde SQL directo.
CREATE OR REPLACE FUNCTION public.guard_platform_admin_account_delete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.platform_admins WHERE visiting_account_id = OLD.id) THEN
    RAISE EXCEPTION 'Sal de la cuenta antes de eliminarla' USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;
$$;
ALTER FUNCTION public.guard_platform_admin_account_delete() OWNER TO postgres;
DROP TRIGGER IF EXISTS guard_platform_admin_account_delete ON public.accounts;
CREATE TRIGGER guard_platform_admin_account_delete BEFORE DELETE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.guard_platform_admin_account_delete();

COMMIT;
