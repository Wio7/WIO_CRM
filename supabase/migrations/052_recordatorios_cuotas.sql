-- ============================================================
-- 052_recordatorios_cuotas.sql — "tu cuota vence el viernes" (E7)
--
-- Tres avisos por cuota pendiente: tres días antes, el día que vence y
-- tres días después si sigue sin pagar. Cada uno sale una sola vez: esta
-- tabla es el registro, y su UNIQUE (cuota, tipo) es lo que impide que un
-- pinger que corre cada 5 minutos mande el mismo aviso doce veces.
--
-- Por dónde sale lo decide el servidor, no esta tabla:
--   · al celular y al chat de la app, siempre que el cliente la use
--     (gratis, funciona ya);
--   · por WhatsApp con una plantilla aprobada, cuando la cuenta de Meta
--     tenga método de pago (WHATSAPP_CUOTA_TEMPLATE en Vercel).
--
-- Idempotente — se puede volver a correr.
-- ============================================================

CREATE TABLE IF NOT EXISTS installment_reminders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  installment_id  uuid NOT NULL REFERENCES installments(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('antes', 'hoy', 'vencida')),
  -- Por dónde salió de verdad: 'app', 'whatsapp', ambos ('app+whatsapp')
  -- o 'ninguno' si el cliente no tenía cómo recibirlo.
  channels        text NOT NULL DEFAULT 'ninguno',
  error           text,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installment_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_installment_reminders_account
  ON installment_reminders(account_id, sent_at DESC);

ALTER TABLE installment_reminders ENABLE ROW LEVEL SECURITY;

-- El equipo lo lee (para ver en la ficha qué se le avisó); escribe sólo
-- el servidor, con el service role.
DROP POLICY IF EXISTS installment_reminders_select ON installment_reminders;
CREATE POLICY installment_reminders_select ON installment_reminders FOR SELECT
  USING (is_account_member(account_id));

-- Interruptor por cuenta, encendido por defecto.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS payment_reminders_enabled boolean NOT NULL DEFAULT true;

COMMENT ON TABLE installment_reminders IS
  'Avisos de cuota ya enviados (3 días antes, el día, 3 días después). Uno por cuota y tipo.';
