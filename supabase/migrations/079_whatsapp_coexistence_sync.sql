-- Coexistencia: importación silenciosa, idempotente y sin borrar datos previos.
BEGIN;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS whatsapp_profile_name TEXT;
CREATE INDEX IF NOT EXISTS messages_coexistence_latest_idx
  ON public.messages(conversation_id, created_at DESC, id DESC);

-- No inferimos procedencia para nombres antiguos: se conservan por seguridad.
CREATE OR REPLACE FUNCTION public.coexistence_contact_name(p_account UUID, p_contact UUID, p_name TEXT)
RETURNS VOID LANGUAGE sql SET search_path = public AS $$
  UPDATE contacts SET name = p_name, whatsapp_profile_name = p_name
  WHERE id = p_contact AND account_id = p_account AND nullif(trim(p_name), '') IS NOT NULL
    AND (nullif(trim(name), '') IS NULL OR name = phone OR name = whatsapp_profile_name);
$$;
CREATE OR REPLACE FUNCTION public.coexistence_guard_contact_name()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name AND NEW.name IS DISTINCT FROM NEW.whatsapp_profile_name THEN
    NEW.whatsapp_profile_name := NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS coexistence_guard_contact_name ON public.contacts;
CREATE TRIGGER coexistence_guard_contact_name BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.coexistence_guard_contact_name();

-- Conserva las funciones de reparto/avisos; sólo omite la creación silenciosa.
DROP TRIGGER IF EXISTS assign_new_conversation ON public.conversations;
CREATE TRIGGER assign_new_conversation BEFORE INSERT ON public.conversations
  FOR EACH ROW WHEN (current_setting('wio.coexistence_sync', true) IS DISTINCT FROM 'on')
  EXECUTE FUNCTION public.assign_new_conversation();
DROP TRIGGER IF EXISTS on_conversation_assigned ON public.conversations;
CREATE TRIGGER on_conversation_assigned AFTER INSERT OR UPDATE OF assigned_agent_id ON public.conversations
  FOR EACH ROW WHEN (current_setting('wio.coexistence_sync', true) IS DISTINCT FROM 'on')
  EXECUTE FUNCTION public.notify_conversation_assigned();
DROP TRIGGER IF EXISTS reiniciar_seguimiento ON public.messages;
CREATE TRIGGER reiniciar_seguimiento AFTER INSERT ON public.messages
  FOR EACH ROW WHEN (NEW.source IS DISTINCT FROM 'phone_history')
  EXECUTE FUNCTION public.reiniciar_seguimiento();

CREATE OR REPLACE FUNCTION public.coexistence_conversation(p_account UUID, p_user UUID, p_contact UUID)
RETURNS public.conversations LANGUAGE plpgsql SET search_path = public AS $$
DECLARE result conversations; previous_setting TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM contacts WHERE id = p_contact AND account_id = p_account) THEN
    RAISE EXCEPTION 'Contacto fuera de la cuenta';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_account::text || p_contact::text, 0));
  SELECT * INTO result FROM conversations WHERE account_id = p_account AND contact_id = p_contact
    ORDER BY created_at, id LIMIT 1;
  IF result.id IS NULL THEN
    previous_setting := current_setting('wio.coexistence_sync', true);
    PERFORM set_config('wio.coexistence_sync', 'on', true);
    INSERT INTO conversations(account_id, user_id, contact_id) VALUES(p_account, p_user, p_contact)
      RETURNING * INTO result;
    PERFORM set_config('wio.coexistence_sync', coalesce(previous_setting, ''), true);
  END IF;
  RETURN result;
END;
$$;

-- Bloqueo por cuenta en TODOS los inserts: también cubre carreras con envíos
-- del CRM o mensajes entrantes. No requiere eliminar duplicados históricos
-- para construir un índice único y mantiene válidos los IDs entre cuentas.
CREATE OR REPLACE FUNCTION public.coexistence_dedupe_message()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE tenant UUID;
BEGIN
  IF NEW.message_id IS NULL THEN RETURN NEW; END IF;
  SELECT account_id INTO tenant FROM conversations WHERE id = NEW.conversation_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text, 79));
  IF EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.account_id = tenant AND m.message_id = NEW.message_id) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS coexistence_dedupe_message ON public.messages;
CREATE TRIGGER coexistence_dedupe_message BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.coexistence_dedupe_message();

CREATE OR REPLACE FUNCTION public.coexistence_insert_messages(p_account UUID, p_conversation UUID, p_rows JSONB)
RETURNS VOID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE latest messages;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM conversations WHERE id = p_conversation AND account_id = p_account) THEN
    RAISE EXCEPTION 'Conversación fuera de la cuenta';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_account::text, 79));
  INSERT INTO messages(conversation_id, sender_type, sender_id, content_type, content_text,
    media_url, interactive_reply_id, message_id, status, created_at, source)
  SELECT p_conversation, r.sender_type, NULL, r.content_type, r.content_text, r.media_url,
    r.interactive_reply_id, r.message_id, r.status, r.created_at, r.source
  FROM jsonb_populate_recordset(NULL::messages, p_rows) r
  WHERE r.message_id IS NOT NULL AND r.source IN ('phone_app', 'phone_history');

  -- Recalcular también en reintentos. El WHERE es atómico: un chunk antiguo
  -- no puede desplazar una actividad más reciente ni incrementar no leídos.
  SELECT * INTO latest FROM messages WHERE conversation_id = p_conversation
    ORDER BY created_at DESC, id DESC LIMIT 1;
  IF latest.id IS NOT NULL THEN
    UPDATE conversations SET last_message_at = latest.created_at,
      last_message_text = coalesce(latest.content_text, '[' || latest.content_type || ']')
    WHERE id = p_conversation AND (last_message_at IS NULL OR last_message_at < latest.created_at);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.coexistence_contact_name(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.coexistence_conversation(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.coexistence_insert_messages(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.coexistence_contact_name(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.coexistence_conversation(UUID, UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.coexistence_insert_messages(UUID, UUID, JSONB) TO service_role;
COMMIT;
