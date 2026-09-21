-- ============================================================
-- 059_seguimiento.sql — al que deja de contestar, se le vuelve a escribir
--
-- Quien llega de una campaña pregunta, le contestamos, y se va a comer.
-- No vuelve. Hoy esa conversación se muere ahí: nadie insiste, y a las 24
-- horas WhatsApp ya no deja escribirle sin plantilla, así que el lead se
-- pierde entero — habiéndolo pagado.
--
-- Con `ai_follows_up` encendido, la IA vuelve a escribirle sola: a la
-- hora, a las tres, a las seis y una última vez antes de que se cierre la
-- ventana de 24 h. Siempre siguiendo el hilo de lo que se estaba
-- hablando, nunca un "hola?" suelto. Y al asesor le suena el celular a la
-- tercera, que es cuando ya toca que escriba una persona.
--
-- Si el cliente contesta, la cuenta vuelve a cero y empieza otra vez
-- desde su último mensaje: los cuatro toques son por silencio, no por
-- conversación.
--
-- Apagado por defecto. Aurex y Luis no se enteran.
--
-- Idempotente — se puede volver a correr.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS ai_follows_up BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN accounts.ai_follows_up IS
  'La IA vuelve a escribir sola al cliente que dejó de contestar (1 h, 3 h, 6 h y antes de las 24 h).';

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS followup_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS followup_last_at TIMESTAMPTZ;

COMMENT ON COLUMN conversations.followup_count IS
  'Cuántas veces se le ha insistido desde su último mensaje. Vuelve a 0 en cuanto el cliente escribe.';
COMMENT ON COLUMN conversations.followup_last_at IS
  'Cuándo salió el último recordatorio. Evita dos seguidos si el que dispara el cron se repite.';

-- El cron mira, cada pocos minutos, las conversaciones vivas con la IA
-- encendida. Este índice es para que esa consulta no crezca con el
-- histórico: sólo importan las que se movieron hace poco.
CREATE INDEX IF NOT EXISTS conversations_seguimiento_idx
  ON conversations (account_id, last_message_at DESC)
  WHERE NOT ai_autoreply_disabled;

-- ============================================================
-- Que el cliente que escribe reinicie la cuenta
--
-- Podría hacerse desde el código que guarda cada mensaje entrante, pero
-- son cuatro caminos distintos (WhatsApp, la app, Messenger/Instagram y
-- el correo) y bastaría olvidarse de uno para que a alguien se le siga
-- insistiendo después de haber contestado. En la base es un sitio solo.
-- ============================================================
CREATE OR REPLACE FUNCTION public.reiniciar_seguimiento()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sender_type = 'customer' THEN
    UPDATE conversations
       SET followup_count = 0,
           followup_last_at = NULL
     WHERE id = NEW.conversation_id
       AND (followup_count <> 0 OR followup_last_at IS NOT NULL);
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.reiniciar_seguimiento() OWNER TO postgres;

DROP TRIGGER IF EXISTS reiniciar_seguimiento ON messages;
CREATE TRIGGER reiniciar_seguimiento
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION reiniciar_seguimiento();

UPDATE accounts
SET ai_follows_up = true
WHERE name ILIKE 'Golden%';
