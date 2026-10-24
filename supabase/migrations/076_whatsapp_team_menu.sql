-- WhatsApp team mode, second step: a conversation starts over after an hour
-- without writing (or with a plain "hola"). The person then picks the
-- assistant from a menu (Golden Caja, Golden App, Golden Legal), and each
-- assistant only remembers what was said since that new start. What they
-- wrote before choosing waits in pending_question and is answered by the
-- assistant they pick. Same file in Wio CRM and Golden Caja.
BEGIN;

ALTER TABLE public.whatsapp_team_sessions
  ADD COLUMN IF NOT EXISTS session_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS pending_question text CHECK (pending_question IS NULL OR length(pending_question) <= 2000);

COMMIT;
