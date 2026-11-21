-- ============================================================
-- 100 · Etapas del cliente que se mueven solas (2026-11-21)
--
-- Pedido de Julio (Broker Home): ver en qué va cada cliente —contestó,
-- en seguimiento, agendó, visitó, compró— sin moverlo a mano.
--
-- Se reusa el embudo que ya existe (pipelines → pipeline_stages → deals,
-- una fila de `deals` por cliente). Lo nuevo:
--   · pipeline_stages.clave: qué significa la etapa, aparte de su nombre.
--     Solo las cuentas que tengan etapas con clave usan esto; al resto
--     (Golden incluida) no le cambia nada.
--   · mover_etapa_cliente(): crea o mueve la fila del cliente. Solo
--     avanza (un cliente que ya agendó no vuelve a "contestó" porque
--     escriba otra vez), salvo p_forzar = true (lo usa el asesor a mano).
--   · Disparadores: mensaje del cliente → nuevo / contestó; cita con
--     cliente → agendó; cita cumplida → visitó. Si algo falla, el mensaje
--     o la cita se guardan igual: la etapa nunca bloquea lo importante.
--   · Las etapas de Broker Home, en español.
--
-- Idempotente: se puede correr dos veces.
-- ============================================================

ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS clave text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_stages_clave_check') THEN
    ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_clave_check
      CHECK (clave IS NULL OR clave IN ('nuevo', 'contesto', 'seguimiento', 'agendo', 'visito', 'compro', 'perdido'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_pipeline_clave_uniq
  ON pipeline_stages (pipeline_id, clave) WHERE clave IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deals_contact ON deals (contact_id);

-- Orden de avance. Perdido y compró son finales: no se sale de ellos solo.
CREATE OR REPLACE FUNCTION public.etapa_orden(p_clave text)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_clave
    WHEN 'nuevo' THEN 0 WHEN 'contesto' THEN 1 WHEN 'seguimiento' THEN 2
    WHEN 'agendo' THEN 3 WHEN 'visito' THEN 4 WHEN 'compro' THEN 5
    WHEN 'perdido' THEN 6 ELSE NULL END
$$;

-- Crea o mueve la fila del cliente. Devuelve la clave en la que quedó,
-- o NULL si la cuenta no tiene etapas con clave (no hace nada).
CREATE OR REPLACE FUNCTION public.mover_etapa_cliente(
  p_account uuid, p_contact uuid, p_conversation uuid, p_clave text, p_forzar boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_etapa record;
  v_deal record;
  v_actual text;
  v_owner uuid;
  v_titulo text;
BEGIN
  IF p_account IS NULL OR p_contact IS NULL OR etapa_orden(p_clave) IS NULL THEN
    RETURN NULL;
  END IF;
  -- Con sesión, solo alguien del equipo de esa cuenta. Sin sesión es el
  -- servidor o un disparador (anon no tiene permiso de ejecutar).
  IF auth.uid() IS NOT NULL AND NOT is_account_member(p_account, 'agent') THEN
    RAISE EXCEPTION 'sin acceso a esta cuenta' USING ERRCODE = '42501';
  END IF;

  SELECT s.id, s.pipeline_id INTO v_etapa
  FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
  WHERE p.account_id = p_account AND s.clave = p_clave
  ORDER BY p.created_at LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- El cliente tiene que ser de esta cuenta.
  IF NOT EXISTS (SELECT 1 FROM contacts WHERE id = p_contact AND account_id = p_account) THEN
    RETURN NULL;
  END IF;

  SELECT d.id, s.clave INTO v_deal
  FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id
  WHERE d.contact_id = p_contact AND d.pipeline_id = v_etapa.pipeline_id
  ORDER BY d.updated_at DESC NULLS LAST LIMIT 1;

  IF NOT FOUND THEN
    SELECT owner_user_id INTO v_owner FROM accounts WHERE id = p_account;
    SELECT coalesce(nullif(trim(name), ''), phone, 'Cliente') INTO v_titulo FROM contacts WHERE id = p_contact;
    INSERT INTO deals (user_id, account_id, pipeline_id, stage_id, contact_id, conversation_id, title, status)
    VALUES (v_owner, p_account, v_etapa.pipeline_id, v_etapa.id, p_contact, p_conversation, v_titulo,
            CASE p_clave WHEN 'compro' THEN 'won' WHEN 'perdido' THEN 'lost' ELSE 'open' END);
    RETURN p_clave;
  END IF;

  v_actual := v_deal.clave;
  IF NOT p_forzar AND (
       v_actual IN ('compro', 'perdido')
       OR coalesce(etapa_orden(v_actual), -1) >= etapa_orden(p_clave)) THEN
    RETURN v_actual;
  END IF;

  UPDATE deals SET
    stage_id = v_etapa.id,
    status = CASE p_clave WHEN 'compro' THEN 'won' WHEN 'perdido' THEN 'lost' ELSE 'open' END,
    conversation_id = coalesce(conversation_id, p_conversation),
    updated_at = now()
  WHERE id = v_deal.id;
  RETURN p_clave;
END $$;

REVOKE ALL ON FUNCTION public.mover_etapa_cliente(uuid, uuid, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mover_etapa_cliente(uuid, uuid, uuid, text, boolean) TO authenticated, service_role;

-- Mensaje del cliente: primer mensaje = nuevo; si ya le habíamos escrito
-- (asesor o IA), contestó.
CREATE OR REPLACE FUNCTION public.etapa_por_mensaje()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_conv record;
  v_clave text;
BEGIN
  IF NEW.sender_type <> 'customer' THEN RETURN NEW; END IF;
  SELECT account_id, contact_id INTO v_conv FROM conversations WHERE id = NEW.conversation_id;
  IF v_conv.contact_id IS NULL OR v_conv.account_id IS NULL THEN RETURN NEW; END IF;
  -- Atajo barato: la cuenta no usa etapas con clave.
  IF NOT EXISTS (SELECT 1 FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
                 WHERE p.account_id = v_conv.account_id AND s.clave IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  v_clave := CASE WHEN EXISTS (
      SELECT 1 FROM messages m WHERE m.conversation_id = NEW.conversation_id
        AND m.sender_type IN ('agent', 'bot') AND m.created_at <= coalesce(NEW.created_at, now()))
    THEN 'contesto' ELSE 'nuevo' END;
  PERFORM mover_etapa_cliente(v_conv.account_id, v_conv.contact_id, NEW.conversation_id, v_clave, false);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'etapa_por_mensaje: %', SQLERRM;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS etapa_por_mensaje ON messages;
CREATE TRIGGER etapa_por_mensaje AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.etapa_por_mensaje();

-- Cita con cliente: agendada → agendó; cumplida → visitó.
CREATE OR REPLACE FUNCTION public.etapa_por_cita()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.contact_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.contact_id IS NOT DISTINCT FROM OLD.contact_id THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'agendada' THEN
    PERFORM mover_etapa_cliente(NEW.account_id, NEW.contact_id, NULL, 'agendo', false);
  ELSIF NEW.status = 'cumplida' THEN
    PERFORM mover_etapa_cliente(NEW.account_id, NEW.contact_id, NULL, 'visito', false);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'etapa_por_cita: %', SQLERRM;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS etapa_por_cita ON appointments;
CREATE TRIGGER etapa_por_cita AFTER INSERT OR UPDATE OF status, contact_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION public.etapa_por_cita();

-- Etapas de Broker Home en español (cuenta d495a2dc…, embudo "Sales Pipeline").
DO $$
DECLARE
  v_pipe uuid;
BEGIN
  SELECT id INTO v_pipe FROM pipelines
  WHERE account_id = 'd495a2dc-6d3b-43a1-8841-ab5a1f5a27fe'
  ORDER BY created_at LIMIT 1;
  IF v_pipe IS NULL THEN RETURN; END IF;

  UPDATE pipelines SET name = 'Clientes' WHERE id = v_pipe;

  UPDATE pipeline_stages SET name = 'Nuevo', clave = 'nuevo', position = 0, color = '#64748b'
    WHERE pipeline_id = v_pipe AND (clave = 'nuevo' OR (clave IS NULL AND name = 'New Lead'));
  UPDATE pipeline_stages SET name = 'Contestó', clave = 'contesto', position = 1, color = '#0ea5e9'
    WHERE pipeline_id = v_pipe AND (clave = 'contesto' OR (clave IS NULL AND name = 'Qualified'));
  UPDATE pipeline_stages SET name = 'En seguimiento', clave = 'seguimiento', position = 2, color = '#8b5cf6'
    WHERE pipeline_id = v_pipe AND (clave = 'seguimiento' OR (clave IS NULL AND name = 'Proposal Sent'));
  UPDATE pipeline_stages SET name = 'Agendó visita', clave = 'agendo', position = 3, color = '#f59e0b'
    WHERE pipeline_id = v_pipe AND (clave = 'agendo' OR (clave IS NULL AND name = 'Negotiation'));
  UPDATE pipeline_stages SET name = 'Separó / compró', clave = 'compro', position = 5, color = '#16a34a'
    WHERE pipeline_id = v_pipe AND (clave = 'compro' OR (clave IS NULL AND name = 'Won'));

  IF NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE pipeline_id = v_pipe AND clave = 'visito') THEN
    INSERT INTO pipeline_stages (pipeline_id, name, position, color, clave) VALUES (v_pipe, 'Visitó', 4, '#14b8a6', 'visito');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE pipeline_id = v_pipe AND clave = 'perdido') THEN
    INSERT INTO pipeline_stages (pipeline_id, name, position, color, clave) VALUES (v_pipe, 'Perdido', 6, '#ef4444', 'perdido');
  END IF;
END $$;

-- Relleno: los clientes que ya escribieron quedan en Nuevo o Contestó, y
-- los que tienen cita en Agendó / Visitó. Solo avanza: correrlo dos veces
-- no cambia nada.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.account_id, c.contact_id, c.id AS conversation_id,
           CASE WHEN EXISTS (
             SELECT 1 FROM messages mc WHERE mc.conversation_id = c.id AND mc.sender_type = 'customer'
               AND EXISTS (SELECT 1 FROM messages ma WHERE ma.conversation_id = c.id
                             AND ma.sender_type IN ('agent', 'bot') AND ma.created_at <= mc.created_at))
           THEN 'contesto' ELSE 'nuevo' END AS clave
    FROM conversations c
    WHERE c.account_id = 'd495a2dc-6d3b-43a1-8841-ab5a1f5a27fe' AND c.contact_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.sender_type = 'customer')
  LOOP
    PERFORM mover_etapa_cliente(r.account_id, r.contact_id, r.conversation_id, r.clave, false);
  END LOOP;
  FOR r IN
    SELECT account_id, contact_id, status FROM appointments
    WHERE account_id = 'd495a2dc-6d3b-43a1-8841-ab5a1f5a27fe' AND contact_id IS NOT NULL AND status <> 'cancelada'
  LOOP
    PERFORM mover_etapa_cliente(r.account_id, r.contact_id, NULL,
      CASE r.status WHEN 'cumplida' THEN 'visito' ELSE 'agendo' END, false);
  END LOOP;
END $$;
