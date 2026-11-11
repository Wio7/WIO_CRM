-- ============================================================
-- 091_invitacion_promueve.sql — Invitar asesores Promueve con el enlace de siempre
--
-- Casos: supabase/tests/091_casos.sql (correr DESPUÉS de aplicar esta).
-- Requiere: 019 (peek/redeem), 040 (account_invitations.email) y
--           089 (profiles.area = 'promueve').
--
-- Antes: los asesores externos de Promueve se registraban solos con un
-- código (POST /api/promueve/registro, 089). Ahora Bryce quiere el MISMO
-- procedimiento que ya se usa con el equipo: el dueño o un administrador
-- crea una invitación en la Golden App (Equipo), manda el enlace por
-- WhatsApp y quien lo abre pone nombre y contraseña y queda dentro con la
-- vista restringida de Promueve. Lo único nuevo es que la invitación puede
-- llevar un área.
--
-- Qué cambia:
--   1. account_invitations.area (NULL = invitación normal). Solo
--      'promueve', y solo junto a role = 'agent' (un Promueve es siempre un
--      agente externo; 089 ya impide dárselo a un dueño o administrador).
--   2. redeem_invitation: copia exacta de la 019 con UN cambio: si la
--      invitación trae área, el perfil queda con esa área (y area_set_at).
--      Nada más cambia: misma firma, mismos permisos, mismas negativas.
--        · El guard de 084 (el área solo cambia por set_member_area) no
--          estorba: la función es SECURITY DEFINER y corre como postgres.
--        · La limpieza de la cuenta personal huérfana es la de siempre; y
--          las mismas negativas valen para el área: quien ya es miembro,
--          está en otra cuenta compartida o tiene datos NO recibe el área
--          (el canje se rechaza antes de tocar su perfil). Por eso un
--          administrador no puede "ponerle Promueve" a alguien que ya
--          estaba en el CRM: el área solo la recibe un invitado nuevo.
--   3. peek_invitation: copia de la 019 + 'area' en el JSON (null si no
--      hay). La usa GET /api/invitations/[token]/peek.
--
-- Importante antes de aplicar en producción: la base real se desvía de las
-- migraciones del repo. Confirmar que la definición vigente de
-- redeem_invitation / peek_invitation coincide con la 019:
--   select pg_get_functiondef('public.redeem_invitation(text)'::regprocedure);
--   select pg_get_functiondef('public.peek_invitation(text)'::regprocedure);
-- Si tiene algo más, sumarlo aquí antes de correr (esta migración las
-- reemplaza enteras).
--
-- Idempotente — se puede volver a correr.
-- ============================================================
BEGIN;

-- ============================================================
-- 1. Área en la invitación
-- ============================================================
ALTER TABLE public.account_invitations ADD COLUMN IF NOT EXISTS area text;

ALTER TABLE public.account_invitations DROP CONSTRAINT IF EXISTS account_invitations_area_check;
ALTER TABLE public.account_invitations
  ADD CONSTRAINT account_invitations_area_check
  CHECK (area IS NULL OR (area = 'promueve' AND role = 'agent'));

COMMENT ON COLUMN public.account_invitations.area IS
  'Área que recibe quien canjea la invitación (hoy solo ''promueve'', con role agent). NULL = invitación normal.';

-- ============================================================
-- 2. peek_invitation: 019 + area
-- ============================================================
CREATE OR REPLACE FUNCTION public.peek_invitation(
  p_token_hash TEXT
) RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv account_invitations%ROWTYPE;
  v_account_name TEXT;
BEGIN
  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_inv.accepted_at IS NOT NULL THEN
    RETURN json_build_object('ok', false, 'reason', 'used');
  END IF;

  IF v_inv.expires_at <= NOW() THEN
    RETURN json_build_object('ok', false, 'reason', 'expired');
  END IF;

  SELECT name INTO v_account_name
  FROM accounts
  WHERE id = v_inv.account_id;

  RETURN json_build_object(
    'ok', true,
    'account_name', v_account_name,
    'role', v_inv.role,
    'area', v_inv.area,
    'expires_at', v_inv.expires_at
  );
END;
$$;

ALTER FUNCTION public.peek_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.peek_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.peek_invitation(TEXT) TO anon, authenticated;

-- ============================================================
-- 3. redeem_invitation: 019 + el área de la invitación
-- ============================================================
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID  -- the joined account_id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  -- Caller's current account + its owner.
  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_old_account_id IS NULL THEN
    -- Defensive — every authenticated user has a profile post-017.
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  -- Edge case: the inviter sent themselves a link, or the
  -- caller is somehow already in the inviter's account.
  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  -- Safety: the caller must be the SOLE OWNER of their current
  -- account (i.e. their fresh personal account from signup or a
  -- prior removal). Any other state means they're either:
  --   - a member of another shared account (joining a second
  --     would silently orphan their access to the first), or
  --   - the owner of an account with teammates (they'd abandon
  --     their team to join the inviter's).
  -- Either way, the safe answer is "make a different login".
  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Belt: even if they own their account, refuse if it has any
  -- domain data — joining would orphan their contacts, deals,
  -- broadcasts, automations, flows, templates, etc.
  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Move the profile first so the cascade-on-delete of the old
  -- account doesn't try to nuke this user's profile too.
  -- 091: una invitación con área (Promueve) deja el perfil con esa área.
  -- Lo hace esta función SECURITY DEFINER, no el usuario: el guard de 084
  -- sigue negando el cambio de área desde la API.
  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role,
      area = COALESCE(v_inv.area, area),
      area_set_at = CASE WHEN v_inv.area IS NOT NULL THEN NOW() ELSE area_set_at END
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Clean up the orphan personal account. Empty by the checks
  -- above, so this is purely housekeeping — no cascades fire
  -- because no other rows reference it.
  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;

COMMIT;

-- PostgREST lee el esquema nuevo sin reiniciar.
NOTIFY pgrst, 'reload schema';
