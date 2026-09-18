-- ============================================================
-- 049_agenda.sql — Citas: quién atiende, cuándo, y con quién
--
-- Hasta hoy una videollamada se acordaba por chat ("mañana en la tarde")
-- y quedaba en la cabeza de dos personas. Esto le da un sitio:
--
--   staff_availability   los horarios que cada persona ofrece, por día
--                        de la semana. No son citas: son las horas en
--                        las que se la puede buscar.
--   appointments         la cita en firme, con su hora exacta y su sala.
--
-- Quién atiende a quién sale de lo que ya decidimos: al cliente que paga
-- lo lleva cobranzas; al que todavía mira, ventas. La cita guarda el
-- `user_id` concreto para que nadie se quede esperando a "alguien".
--
-- Sobre las horas: Perú no cambia la hora en todo el año (UTC-5 fijo),
-- así que la disponibilidad se guarda en MINUTOS DESDE MEDIANOCHE hora de
-- Lima y la cita en `timestamptz`. Sin cambio de horario no hay ninguna
-- de las trampas que suelen tener los calendarios.
--
-- Idempotente — se puede volver a correr.
-- ============================================================

-- ============================================================
-- 1. Cuándo atiende cada uno
--
-- Una fila por tramo: "los martes de 9:00 a 13:00" son 2, 540, 780. Se
-- permiten varios tramos por día (mañana y tarde) sin trucos.
-- ============================================================
CREATE TABLE IF NOT EXISTS staff_availability (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- El usuario de auth, no el perfil: es lo que guarda
  -- `conversations.assigned_agent_id`, y así una cosa se compara con la
  -- otra sin traducciones.
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 0 = domingo … 6 = sábado, igual que `getDay()` en el navegador.
  weekday    smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts_min smallint NOT NULL CHECK (starts_min BETWEEN 0 AND 1439),
  ends_min   smallint NOT NULL CHECK (ends_min BETWEEN 1 AND 1440),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_min > starts_min),
  UNIQUE (user_id, weekday, starts_min)
);

CREATE INDEX IF NOT EXISTS idx_availability_account
  ON staff_availability(account_id, weekday);

-- ============================================================
-- 2. Las citas
-- ============================================================
CREATE TABLE IF NOT EXISTS appointments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Si borran el contacto, la cita sobrevive en la agenda de quien la
  -- iba a atender: su hora sigue ocupada.
  contact_id  uuid REFERENCES contacts(id) ON DELETE SET NULL,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  starts_at   timestamptz NOT NULL,
  minutes     smallint NOT NULL DEFAULT 30 CHECK (minutes BETWEEN 10 AND 240),
  kind        text NOT NULL DEFAULT 'videollamada'
                CHECK (kind IN ('videollamada', 'visita', 'llamada')),
  status      text NOT NULL DEFAULT 'agendada'
                CHECK (status IN ('agendada', 'cumplida', 'cancelada')),
  -- La sala de la videollamada. Se guarda con la cita para que el asesor
  -- entre a la MISMA que el cliente sin tener que pasarse un enlace.
  room        text,
  notes       text,
  -- Quién la creó: el cliente desde la app, o alguien del equipo.
  created_by  text NOT NULL DEFAULT 'equipo' CHECK (created_by IN ('cliente', 'equipo')),
  -- Cuándo se avisó. Dos columnas y no una: el aviso de la hora y el de
  -- la media hora son avisos distintos, y así reenviar uno no borra el
  -- otro ni manda dos veces el mismo.
  reminded_60 timestamptz,
  reminded_30 timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appointments_agenda
  ON appointments(account_id, starts_at)
  WHERE status = 'agendada';

CREATE INDEX IF NOT EXISTS idx_appointments_user
  ON appointments(user_id, starts_at);

CREATE INDEX IF NOT EXISTS idx_appointments_contact
  ON appointments(contact_id, starts_at);

-- Dos citas a la misma hora con la misma persona no son un error de
-- criterio, son un error: se prohíben en la base y no en la pantalla,
-- porque hay dos pantallas (la del cliente y la del asesor) que pueden
-- guardar a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_sin_choque
  ON appointments(user_id, starts_at)
  WHERE status = 'agendada';

-- ============================================================
-- 3. Row level security — como el resto del CRM
--
-- El cliente no aparece por aquí: entra por el servidor, que filtra por
-- su contacto (después de la 041 no es miembro de la cuenta).
-- ============================================================
ALTER TABLE staff_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS availability_select ON staff_availability;
CREATE POLICY availability_select ON staff_availability FOR SELECT
  USING (is_account_member(account_id));

-- Cada uno edita su horario; los administradores, el de cualquiera.
DROP POLICY IF EXISTS availability_write ON staff_availability;
CREATE POLICY availability_write ON staff_availability FOR ALL
  USING (
    is_account_member(account_id, 'agent')
    AND (user_id = auth.uid() OR is_account_member(account_id, 'admin'))
  )
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND (user_id = auth.uid() OR is_account_member(account_id, 'admin'))
  );

DROP POLICY IF EXISTS appointments_select ON appointments;
CREATE POLICY appointments_select ON appointments FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS appointments_write ON appointments;
CREATE POLICY appointments_write ON appointments FOR ALL
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

-- ============================================================
-- 4. `updated_at` honesto, con el disparador de siempre (001)
-- ============================================================
DROP TRIGGER IF EXISTS appointments_updated_at ON appointments;
CREATE TRIGGER appointments_updated_at
  BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE staff_availability IS
  'Tramos en los que cada persona atiende, por día de la semana, en minutos desde medianoche hora de Lima.';
COMMENT ON TABLE appointments IS
  'Citas en firme (videollamada, visita o llamada) entre un contacto y alguien del equipo.';
