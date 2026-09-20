-- ============================================================
-- 056_ia_o_asesor.sql — pasarse la conversación entre la IA y la persona
--
-- El asesor tiene dos botones en el chat: "la llevo yo" y "que siga la
-- IA". Para que el segundo funcione hacía falta esta marca.
--
-- La regla de la 041 dice que la IA contesta mientras NINGÚN asesor haya
-- escrito en el hilo. Es correcta la primera vez, pero deja la puerta
-- cerrada para siempre: si el asesor contestó una vez, la IA ya no vuelve
-- aunque se lo pidan. `ai_resumed_at` es ese "desde aquí, otra vez tú":
-- sólo cuentan los mensajes del equipo posteriores a esa hora.
--
-- Idempotente — se puede volver a correr.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_resumed_at timestamptz;

COMMENT ON COLUMN conversations.ai_resumed_at IS
  'Cuándo se le devolvió la conversación a la IA. Los mensajes del equipo anteriores a esta hora no la silencian.';
