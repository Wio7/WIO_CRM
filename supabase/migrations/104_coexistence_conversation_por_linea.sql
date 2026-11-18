-- 104: coexistence_conversation resuelve el hilo por contacto Y línea.
-- Antes (079) devolvía el primer hilo del contacto sin mirar la línea: con
-- varias líneas, el eco/historial de la línea B caía en el hilo de la A.
-- p_line NULL conserva el comportamiento anterior (primer hilo del contacto).
-- Los hilos antiguos con line_id NULL solo los reutiliza la línea principal.
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
