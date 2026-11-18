-- ============================================================
-- 103_whatsapp_lineas.sql — varias líneas de WhatsApp por cuenta
--
-- Hasta ahora una cuenta tenía UN número (017: UNIQUE(account_id) en
-- whatsapp_config). Golden Habitat necesita varias líneas (ventas, legal,
-- cobranzas, posventa...), cada una con su área. Esta migración:
--
--   1. Convierte whatsapp_config en una tabla de líneas: quita
--      UNIQUE(account_id) y agrega line_name, area, logo_url, is_primary y
--      sort_order. La unicidad por phone_number_id (013) se conserva: un
--      mismo número no puede estar en dos filas. Solo una línea principal
--      por cuenta (índice único parcial whatsapp_config_one_primary).
--      La fila única de cada cuenta pasa a ser la principal, 'Principal'.
--   2. conversations: line_id (la línea por la que habla el contacto; un hilo
--      por contacto y línea) y area (área dueña del hilo; NULL = sin área).
--      Las conversaciones existentes quedan en la línea principal de su cuenta.
--   3. Agrega el área 'posventa' a profiles.area (092) y a
--      account_invitations.area (091); se conservan todos los valores previos.
--   4. can_access_conversation(cuenta, asignado, area): sobrecarga de 3
--      argumentos. Conserva la lógica vigente (055) y suma el área de la
--      conversación: sin área, o dueño / administrador sin área / usuario del
--      área 'gerencia' → como hoy; con área, el usuario debe tener esa área.
--      Lo asignado a uno es siempre suyo. conversations_select y
--      messages_select pasan a usarla con c.area.
--
-- Nota: la sobrecarga vieja (uuid, uuid, account_role_enum) sigue ahí para
-- las políticas de update/delete/modify (039). Una llamada con un literal sin
-- tipo ('agent') se resolvería a la sobrecarga de texto: castear siempre
-- ('agent'::account_role_enum) al llamarla desde código nuevo.
--
--   5. set_member_area (copia de 092) acepta también 'posventa'; el resto igual.
--
-- Llamadores: la sobrecarga de 2 args (uuid, uuid) sigue funcionando; con 3 args
-- castear siempre el rol: 'agent'::account_role_enum (un literal sin tipo
-- se resuelve a la sobrecarga de texto del área).
--
-- Idempotente — se puede volver a correr. Requiere 017, 039, 055, 091, 092.
-- ============================================================
BEGIN;

-- ============================================================
-- 1. whatsapp_config como tabla de líneas
-- ============================================================
ALTER TABLE public.whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS line_name TEXT NOT NULL DEFAULT 'Principal',
  ADD COLUMN IF NOT EXISTS area TEXT,
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;

ALTER TABLE public.whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_area_check;
ALTER TABLE public.whatsapp_config
  ADD CONSTRAINT whatsapp_config_area_check
  CHECK (area IS NULL OR area IN ('marketing', 'legal', 'cobranzas', 'ventas', 'gerencia', 'contabilidad', 'tecnica', 'promueve', 'administracion', 'posventa'));

-- La fila (única hasta ahora) de cada cuenta es su línea principal. Antes del
-- índice único; si una cuenta ya tuviera principal, no se toca.
UPDATE public.whatsapp_config w
   SET is_primary = true
 WHERE w.id = (
         SELECT x.id FROM public.whatsapp_config x
          WHERE x.account_id = w.account_id
          ORDER BY x.created_at NULLS LAST, x.id
          LIMIT 1)
   AND NOT EXISTS (
         SELECT 1 FROM public.whatsapp_config y
          WHERE y.account_id = w.account_id AND y.is_primary);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_one_primary
  ON public.whatsapp_config (account_id)
  WHERE is_primary;

-- ============================================================
-- 2. Hilo por línea y área en conversations
-- ============================================================
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS line_id UUID REFERENCES public.whatsapp_config(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS area TEXT;

UPDATE public.conversations c
   SET line_id = w.id
  FROM public.whatsapp_config w
 WHERE c.line_id IS NULL
   AND w.account_id = c.account_id
   AND w.is_primary;

UPDATE public.conversations c
   SET area = w.area
  FROM public.whatsapp_config w
 WHERE c.area IS NULL
   AND c.line_id = w.id
   AND w.area IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_line
  ON public.conversations (line_id);
CREATE INDEX IF NOT EXISTS idx_conversations_account_area
  ON public.conversations (account_id, area)
  WHERE area IS NOT NULL;

-- ============================================================
-- 3. Área 'posventa' (profiles 092:43, invitaciones 091:49)
-- ============================================================
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_area_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_area_check
  CHECK (area IS NULL OR area IN ('marketing', 'legal', 'cobranzas', 'ventas', 'gerencia', 'contabilidad', 'tecnica', 'promueve', 'administracion', 'posventa'));

ALTER TABLE public.account_invitations DROP CONSTRAINT IF EXISTS account_invitations_area_check;
ALTER TABLE public.account_invitations
  ADD CONSTRAINT account_invitations_area_check
  CHECK (area IS NULL OR (area = 'promueve' AND role = 'agent') OR area = 'posventa');

-- ============================================================
-- 4. can_access_conversation con área
--
-- Miembro AND una de:
--   · la conversación es suya (asignada al usuario): siempre;
--   · la conversación NO tiene área: exactamente la lógica de 055 (cuenta sin
--     restricción, o dueño / admin general / jefe de ventas / admin de su
--     área). Todas las conversaciones existentes quedan así (área NULL);
--   · la conversación TIENE área: solo cuenta el área. Ven todo el dueño, el
--     administrador sin área y quien tiene el área 'gerencia'; quien tiene
--     esa misma área la ve esté o no asignada. agents_see_only_assigned NO
--     se aplica (también vale en cuentas restringidas como Golden, 055).
-- Rol mínimo: viewer (como el default de 055).
-- ============================================================
CREATE OR REPLACE FUNCTION public.can_access_conversation(
  p_account_id UUID,
  p_assigned_agent_id UUID,
  p_area TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_account_member(p_account_id, 'viewer')
    AND (
      -- La suya, siempre.
      COALESCE(p_assigned_agent_id = auth.uid(), false)
      OR CASE
        WHEN p_area IS NULL THEN
          -- Sin área: la lógica de hoy (055).
          (
            NOT COALESCE(
              (SELECT a.agents_see_only_assigned FROM accounts a WHERE a.id = p_account_id),
              false)
            OR EXISTS (
              SELECT 1
                FROM profiles yo
                LEFT JOIN profiles suyo
                  ON suyo.account_id = p_account_id
                 AND suyo.user_id = p_assigned_agent_id
               WHERE yo.account_id = p_account_id
                 AND yo.user_id = auth.uid()
                 AND (
                   yo.account_role = 'owner'
                   OR (yo.account_role = 'admin' AND yo.area IS NULL)
                   OR (yo.account_role = 'admin' AND yo.area = 'ventas'
                       AND (p_assigned_agent_id IS NULL OR suyo.area = 'ventas' OR suyo.area IS NULL))
                   OR (yo.account_role = 'admin' AND yo.area IS NOT NULL AND yo.area = suyo.area)
                 )
            )
          )
        ELSE
          -- Con área: solo el área.
          EXISTS (
            SELECT 1 FROM profiles yo2
             WHERE yo2.account_id = p_account_id
               AND yo2.user_id = auth.uid()
               AND (
                 yo2.account_role = 'owner'
                 OR (yo2.account_role = 'admin' AND yo2.area IS NULL)
                 OR yo2.area = 'gerencia'
                 OR yo2.area = p_area
               )
          )
      END
    );
$$;

ALTER FUNCTION public.can_access_conversation(UUID, UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_access_conversation(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_conversation(UUID, UUID, TEXT)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.can_access_conversation(UUID, UUID, TEXT) IS
  'Acceso a una conversación (lectura): lógica de 055 + área de la conversación (103). Sin área = como antes; con área, dueño / admin sin área / gerencia / misma área. Lo asignado al usuario se ve siempre.';

-- ============================================================
-- 4b. set_member_area (092 + 'posventa'; el resto igual)
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
     AND p_area NOT IN ('marketing', 'legal', 'cobranzas', 'ventas', 'gerencia', 'contabilidad', 'tecnica', 'promueve', 'administracion', 'posventa') THEN
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
-- 5. Políticas de lectura con el área de la conversación
-- ============================================================
DROP POLICY IF EXISTS conversations_select ON public.conversations;
CREATE POLICY conversations_select ON public.conversations FOR SELECT
  USING (can_access_conversation(account_id, assigned_agent_id, area));

DROP POLICY IF EXISTS messages_select ON public.messages;
CREATE POLICY messages_select ON public.messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = messages.conversation_id
      AND can_access_conversation(c.account_id, c.assigned_agent_id, c.area)
  )
);

-- ============================================================
-- 6. coexistence_conversation por línea
-- Antes (079) devolvía el primer hilo del contacto sin mirar la línea: con
-- varias líneas, el eco/historial de la línea B caía en el hilo de la A.
-- p_line NULL conserva el comportamiento anterior (primer hilo del contacto).
-- Los hilos antiguos con line_id NULL solo los reutiliza la línea principal.
-- ============================================================
DROP FUNCTION IF EXISTS public.coexistence_conversation(UUID, UUID, UUID);

CREATE OR REPLACE FUNCTION public.coexistence_conversation(
  p_account UUID, p_user UUID, p_contact UUID, p_line UUID DEFAULT NULL)
RETURNS public.conversations LANGUAGE plpgsql SET search_path = public AS $$
DECLARE result conversations; previous_setting TEXT; line_primary BOOLEAN; line_area TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM contacts WHERE id = p_contact AND account_id = p_account) THEN
    RAISE EXCEPTION 'Contacto fuera de la cuenta';
  END IF;
  IF p_line IS NOT NULL THEN
    SELECT is_primary, area INTO line_primary, line_area
      FROM whatsapp_config WHERE id = p_line AND account_id = p_account;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Línea fuera de la cuenta';
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_account::text || p_contact::text, 0));
  SELECT * INTO result FROM conversations
   WHERE account_id = p_account AND contact_id = p_contact
     AND (p_line IS NULL
          OR line_id = p_line
          OR (line_id IS NULL AND coalesce(line_primary, false)))
   ORDER BY created_at, id LIMIT 1;
  IF result.id IS NULL THEN
    previous_setting := current_setting('wio.coexistence_sync', true);
    PERFORM set_config('wio.coexistence_sync', 'on', true);
    INSERT INTO conversations(account_id, user_id, contact_id, line_id, area)
      VALUES(p_account, p_user, p_contact, p_line, line_area)
      RETURNING * INTO result;
    PERFORM set_config('wio.coexistence_sync', coalesce(previous_setting, ''), true);
  END IF;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.coexistence_conversation(UUID, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.coexistence_conversation(UUID, UUID, UUID, UUID) TO service_role;

COMMIT;
