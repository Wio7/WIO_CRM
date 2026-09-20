-- ============================================================
-- 055_privacidad_y_reparto.sql — cada chat, de quien le toca
--
-- Dos cosas que hoy están mal en Golden:
--
--   1. TODOS ven TODOS los chats. La cuenta tiene apagado el interruptor
--      `agents_see_only_assigned` (039), y aunque estuviera encendido,
--      "administrador" significaba "ve todo": el de cobranzas vería las
--      conversaciones de ventas. Aquí se afina por ÁREA (046):
--
--        dueño                    todo
--        administrador sin área   todo (es el administrador general)
--        jefe de ventas (admin
--          con área ventas)       todo lo de ventas y lo que no tiene dueño
--        admin de otra área       lo de SU área y lo suyo
--        asesor                   sólo lo suyo
--
--   2. NADIE queda asignado: `auto_assign_new_conversations` también
--      estaba apagado. Ahora, cuando entra una conversación nueva sin
--      dueño, se reparte por área con la misma regla que ya usa la app:
--      si el contacto tiene plan de cuotas es de COBRANZAS; si no, de
--      VENTAS. Sin nadie en esa área, cae al reparto de siempre (039).
--
-- Idempotente — se puede volver a correr.
-- ============================================================

-- ============================================================
-- 1. Los dos interruptores, encendidos para Golden
-- ============================================================
UPDATE accounts
SET agents_see_only_assigned = true,
    auto_assign_new_conversations = true
WHERE name ILIKE 'Golden%';

-- ============================================================
-- 2. Quién puede ver una conversación
--
-- Misma firma que la 039 (las políticas no se tocan): cambia sólo el
-- criterio de adentro.
-- ============================================================
CREATE OR REPLACE FUNCTION can_access_conversation(
  p_account_id UUID,
  p_assigned_agent_id UUID,
  p_min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_account_member(p_account_id, p_min_role)
    AND (
      -- La suya, siempre.
      p_assigned_agent_id = auth.uid()
      -- Cuenta sin restricción: como antes de esto.
      OR NOT COALESCE(
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
             -- Dueño y administrador general: todo.
             yo.account_role = 'owner'
             OR (yo.account_role = 'admin' AND yo.area IS NULL)
             -- Jefe de ventas: lo de ventas y lo que todavía no tiene dueño.
             OR (yo.account_role = 'admin' AND yo.area = 'ventas'
                 AND (p_assigned_agent_id IS NULL OR suyo.area = 'ventas' OR suyo.area IS NULL))
             -- Administrador de un área: lo de su área.
             OR (yo.account_role = 'admin' AND yo.area IS NOT NULL AND yo.area = suyo.area)
           )
      )
    );
$$;

ALTER FUNCTION can_access_conversation(UUID, UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_access_conversation(UUID, UUID, account_role_enum)
  TO authenticated, service_role;

-- ============================================================
-- 3. A quién le toca una conversación nueva
--
-- El que ya paga es de cobranzas; el que todavía mira, de ventas. Es la
-- misma regla del chat de la app (048), ahora también para WhatsApp,
-- Messenger, Instagram y correo.
-- ============================================================
CREATE OR REPLACE FUNCTION assign_new_conversation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restrict BOOLEAN;
  v_auto     BOOLEAN;
  v_area     TEXT;
  v_elegido  UUID;
BEGIN
  IF NEW.assigned_agent_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT agents_see_only_assigned, auto_assign_new_conversations
    INTO v_restrict, v_auto
    FROM accounts
    WHERE id = NEW.account_id;

  -- La abrió alguien del equipo desde el CRM: es suya.
  IF auth.uid() IS NOT NULL THEN
    IF COALESCE(v_restrict, false)
       AND NOT is_account_member(NEW.account_id, 'admin') THEN
      NEW.assigned_agent_id := auth.uid();
    END IF;
    RETURN NEW;
  END IF;

  IF NOT COALESCE(v_auto, false) THEN
    RETURN NEW;
  END IF;

  v_area := CASE
    WHEN NEW.contact_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM payment_plans pp
       WHERE pp.contact_id = NEW.contact_id
         AND pp.status IN ('activo', 'pagado')
    ) THEN 'cobranzas'
    ELSE 'ventas'
  END;

  v_elegido := pick_area_agent(NEW.account_id, v_area);

  -- Nadie en esa área todavía: el reparto de siempre antes que dejarlo
  -- sin dueño, que es como nadie se entera.
  IF v_elegido IS NULL THEN
    v_elegido := pick_account_agent(NEW.account_id);
  END IF;

  NEW.assigned_agent_id := v_elegido;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Nunca impedir que entre un mensaje porque el reparto falló.
  RAISE WARNING 'assign_new_conversation failed for account %: %', NEW.account_id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION assign_new_conversation() OWNER TO postgres;

DROP TRIGGER IF EXISTS assign_new_conversation ON conversations;
CREATE TRIGGER assign_new_conversation
  BEFORE INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION assign_new_conversation();

-- ============================================================
-- 4. Las que ya estaban sin dueño, repartidas con la misma regla
-- ============================================================
UPDATE conversations c
SET assigned_agent_id = COALESCE(
      pick_area_agent(
        c.account_id,
        CASE WHEN EXISTS (
          SELECT 1 FROM payment_plans pp
           WHERE pp.contact_id = c.contact_id
             AND pp.status IN ('activo', 'pagado')
        ) THEN 'cobranzas' ELSE 'ventas' END),
      pick_account_agent(c.account_id))
WHERE c.assigned_agent_id IS NULL
  AND c.account_id IN (SELECT id FROM accounts WHERE name ILIKE 'Golden%');

COMMENT ON FUNCTION can_access_conversation(UUID, UUID, account_role_enum) IS
  'Quién ve una conversación: el dueño y el administrador general todo; el jefe de ventas lo de ventas; un administrador de área lo de su área; un asesor sólo lo suyo.';
