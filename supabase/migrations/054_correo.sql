-- ============================================================
-- 054_correo.sql — El correo (Gmail) en la bandeja
--
-- Un buzón de Gmail por cuenta, conectado con "Conectar Gmail" (OAuth de
-- Google: la contraseña nunca pasa por el CRM). Lo que llega a ese buzón
-- entra a la bandeja como una conversación más, con el cartelito "Por
-- correo", y lo que el asesor contesta sale desde ese mismo buzón, en el
-- mismo hilo de correo.
--
--   email_accounts             el buzón conectado y hasta dónde se leyó
--                              (history_id de Gmail).
--   conversations.email_thread_id / email_subject
--                              el hilo de Gmail de esa conversación, para
--                              que la respuesta caiga en el mismo hilo.
--
-- Los contactos que sólo escriben por correo nacen sin celular (phone '').
--
-- Idempotente — se puede volver a correr.
-- ============================================================

CREATE TABLE IF NOT EXISTS email_accounts (
  account_id     uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  email          text NOT NULL,
  -- AES-256-GCM, igual que los tokens de WhatsApp y Meta.
  refresh_token  text NOT NULL,
  -- Punto desde el que se piden los cambios del buzón. NULL = primera vez.
  history_id     text,
  connected_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  connected_at   timestamptz NOT NULL DEFAULT now(),
  last_sync_at   timestamptz,
  last_error     text,
  is_active      boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE email_accounts ENABLE ROW LEVEL SECURITY;

-- Sólo administradores ven y tocan la conexión; el servidor sincroniza
-- con el service role.
DROP POLICY IF EXISTS email_accounts_admin ON email_accounts;
CREATE POLICY email_accounts_admin ON email_accounts FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS email_accounts_updated_at ON email_accounts;
CREATE TRIGGER email_accounts_updated_at
  BEFORE UPDATE ON email_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS email_thread_id text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS email_subject text;

CREATE INDEX IF NOT EXISTS idx_contacts_email_lower
  ON contacts(account_id, lower(email))
  WHERE email IS NOT NULL;

COMMENT ON TABLE email_accounts IS 'Buzón de Gmail conectado a la bandeja de la cuenta.';
