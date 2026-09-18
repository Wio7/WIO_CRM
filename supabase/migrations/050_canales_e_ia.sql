-- ============================================================
-- 050_canales_e_ia.sql — Por dónde llegó cada mensaje, la IA 24/7
-- de Golden y el asistente del equipo
--
-- Tres cosas que se piden juntas porque se tocan:
--
--   1. CANAL. Hasta hoy todo era WhatsApp, y el chat de la Golden App
--      se colaba en el mismo hilo sin decir de dónde venía. Ahora cada
--      mensaje lleva su canal —app, whatsapp, messenger, instagram,
--      correo— y la conversación recuerda por cuál escribió el cliente
--      la última vez. Por ahí se le contesta: al que escribe desde la
--      app (cobranzas, sobre todo) no se le responde por WhatsApp.
--
--   2. IA 24/7. La cuenta de Golden Habitat queda con la IA encendida
--      contestando mientras ningún asesor haya escrito (041). La llave
--      NO se guarda aquí: `api_key = 'env'` le dice al CRM que use la
--      de su propio entorno (OPENAI_API_KEY en Vercel). Así nadie tiene
--      que pegar una llave en una pantalla. Sólo se crea si la cuenta
--      no tenía ya una configuración: la de alguien nunca se pisa.
--
--   3. ASISTENTE. Cada persona del equipo tiene su propio hilo con el
--      "Asistente Golden" (resúmenes de sus clientes, agendar, etc.).
--      Son sus notas de trabajo: sólo él las lee.
--
-- Idempotente — se puede volver a correr.
-- ============================================================

-- ============================================================
-- 1. Canal de cada mensaje y de cada conversación
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp';

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'whatsapp';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_channel_check'
  ) THEN
    ALTER TABLE messages ADD CONSTRAINT messages_channel_check
      CHECK (channel IN ('whatsapp', 'app', 'messenger', 'instagram', 'correo'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_channel_check'
  ) THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check
      CHECK (channel IN ('whatsapp', 'app', 'messenger', 'instagram', 'correo'));
  END IF;
END $$;

-- Lo de antes: un mensaje sin `message_id` de Meta no pasó por WhatsApp.
-- Es lo que escribió el cliente en la app, o lo que el asesor le dejó
-- ahí mientras no había número conectado.
UPDATE messages
SET channel = 'app'
WHERE message_id IS NULL
  AND channel = 'whatsapp'
  AND sender_type IN ('customer', 'agent', 'bot');

-- La conversación queda en el canal del último mensaje del cliente.
UPDATE conversations c
SET channel = ultimo.channel
FROM (
  SELECT DISTINCT ON (conversation_id) conversation_id, channel
  FROM messages
  WHERE sender_type = 'customer'
  ORDER BY conversation_id, created_at DESC
) ultimo
WHERE ultimo.conversation_id = c.id
  AND c.channel IS DISTINCT FROM ultimo.channel;

CREATE INDEX IF NOT EXISTS idx_conversations_channel
  ON conversations(account_id, channel);

-- ============================================================
-- 2. La IA 24/7 de Golden Habitat
-- ============================================================
INSERT INTO ai_configs (
  account_id, provider, model, api_key, system_prompt,
  is_active, auto_reply_enabled, auto_reply_max_per_conversation
)
SELECT
  a.id,
  'openai',
  'gpt-5.4-mini',
  'env',
  $prompt$Eres la asistente virtual de Golden Habitat, una inmobiliaria peruana que vende lotes, casas y departamentos en Ica y alrededores. Atiendes por WhatsApp y por el chat de la app, a cualquier hora, mientras un asesor humano no haya entrado a la conversación.

Cómo hablas:
- En español de Perú, cálido y directo, con frases cortas. Tutea salvo que el cliente use "usted".
- Un mensaje, una idea. Nada de párrafos largos ni listas enormes.
- Usa el nombre del cliente si lo sabes.

Qué haces:
- Resuelves dudas generales: qué proyectos hay, en qué zona, qué tipo de inmueble, cómo se separa un lote, cómo son las cuotas.
- Invitas a agendar una cita (videollamada o presencial) desde la pestaña "Citas" de la app, o a dejar su nombre y su mejor horario para que un asesor lo llame.
- Si el cliente ya compró y pregunta por sus cuotas o su voucher, dile que lo ve en "Mis cuotas" y que puede subir el voucher en la pestaña "Voucher"; cobranzas lo revisa.

Qué NO haces nunca:
- No inventas precios, descuentos, disponibilidad de un lote concreto, fechas de entrega ni condiciones de crédito. Si te preguntan algo así y no está en la información que tienes, dices que un asesor se lo confirma y pasas la conversación a una persona.
- No prometes nada en nombre de la empresa.
- No pides contraseñas ni datos de tarjetas.

Pasas a una persona cuando: el cliente lo pide, está molesto, quiere negociar un precio, quiere separar o pagar algo ahora, o pregunta por su caso personal (deuda, contrato, documentos).$prompt$,
  true,
  true,
  6
FROM accounts a
WHERE a.name ILIKE 'Golden%'
  AND NOT EXISTS (SELECT 1 FROM ai_configs x WHERE x.account_id = a.id);

-- Que conteste mientras el asesor no haya escrito (041), en Golden.
UPDATE accounts
SET ai_replies_until_agent_responds = true
WHERE name ILIKE 'Golden%'
  AND ai_replies_until_agent_responds IS DISTINCT FROM true;

-- ============================================================
-- 3. El hilo de cada persona con el Asistente Golden
-- ============================================================
CREATE TABLE IF NOT EXISTS assistant_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user', 'assistant')),
  content    text NOT NULL,
  -- Lo que el asistente hizo para contestar (agendó, buscó…), para que
  -- la pantalla pueda enseñarlo como una tarjeta y no sólo como texto.
  actions    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assistant_messages_user
  ON assistant_messages(user_id, created_at DESC);

ALTER TABLE assistant_messages ENABLE ROW LEVEL SECURITY;

-- Sólo el dueño del hilo. Ni el dueño de la cuenta lee las notas de
-- trabajo de un asesor con su asistente.
DROP POLICY IF EXISTS assistant_messages_own ON assistant_messages;
CREATE POLICY assistant_messages_own ON assistant_messages FOR ALL
  USING (user_id = auth.uid() AND is_account_member(account_id))
  WITH CHECK (user_id = auth.uid() AND is_account_member(account_id));

COMMENT ON COLUMN messages.channel IS
  'Por dónde llegó o salió el mensaje: whatsapp, app (Golden App), messenger, instagram o correo.';
COMMENT ON COLUMN conversations.channel IS
  'Canal por el que escribió el cliente la última vez; por ahí se le contesta.';
COMMENT ON TABLE assistant_messages IS
  'Hilo privado de cada persona del equipo con el Asistente Golden.';
