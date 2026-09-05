-- ============================================================
-- 038_power_dialer.sql — Marcado automático (Power Dialer) + registro con IA
--
-- Automatiza el marcado secuencial sobre una cola de leads: el sistema
-- llama, salta al siguiente número si no contestan, y al contestar
-- puentea la llamada al celular del asesor. Cada llamada contestada
-- queda con grabación, transcripción, resumen y recomendación de IA.
--
-- Arquitectura: la cola NO avanza desde un bucle. Twilio es
-- webhook-driven — cada callback de estado es una petición HTTP corta
-- que decide qué sigue (otro número del mismo lead, el siguiente lead,
-- o fin de sesión). Por eso todo esto funciona en serverless sin
-- proceso largo, y por eso el estado de la cola vive aquí y no en
-- memoria.
--
-- Separación intencional entre `call_attempts` y `call_results`: hay
-- ~5 intentos por cada llamada contestada, así que la tabla que más
-- crece se mantiene angosta y los resultados (con transcripción, que
-- es texto largo) viven aparte.
--
-- Idempotente — safe to re-run.
-- ============================================================

-- ============================================================
-- twilio_configs — credenciales de telefonía, una fila por cuenta.
--
-- Mismo modelo que meta_leads_config (036) y whatsapp_config: cada
-- cuenta trae las suyas, cifradas en reposo con ENCRYPTION_KEY
-- (src/lib/whatsapp/encryption.ts). NO son variables de entorno —
-- esto es multi-tenant.
--
-- `from_number` debe ser un número que la empresa POSEE y verificó
-- ante Twilio. Mostrar como caller ID un número ajeno es spoofing:
-- lo bloquea STIR/SHAKEN y lo sanciona Indecopi en Perú.
-- ============================================================
CREATE TABLE IF NOT EXISTS twilio_configs (
  account_id   UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  account_sid  TEXT,
  -- AES-256-GCM (iv:ct:tag). Se usa tanto para llamar a la API REST
  -- como para validar la firma de los webhooks entrantes.
  auth_token   TEXT,
  from_number  TEXT,
  -- Sello de cuando las credenciales se validaron contra la API de
  -- Twilio. Distingue "guardado" de "realmente funciona", igual que
  -- whatsapp_config.registered_at (015).
  verified_at  TIMESTAMPTZ,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE twilio_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS twilio_configs_select ON twilio_configs;
CREATE POLICY twilio_configs_select ON twilio_configs FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS twilio_configs_insert ON twilio_configs;
CREATE POLICY twilio_configs_insert ON twilio_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS twilio_configs_update ON twilio_configs;
CREATE POLICY twilio_configs_update ON twilio_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS twilio_configs_delete ON twilio_configs;
CREATE POLICY twilio_configs_delete ON twilio_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON twilio_configs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON twilio_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- profiles.phone — destino del puente en modo manual.
--
-- Cuando el lead contesta, el TwiML hace <Dial> a este número. Sin
-- él no hay a quién puentear. Nullable: solo los asesores que marcan
-- necesitan tenerlo.
--
-- Sin política RLS nueva ni índice: es una columna más de profiles,
-- cubierta por las políticas de 017, y nunca se filtra por teléfono.
-- ============================================================
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS phone TEXT;

-- ============================================================
-- dial_sessions — una corrida de "Iniciar marcado" por un asesor.
--
-- `mode` ya contempla 'ia' aunque el agente de voz llegue después:
-- así el modelo no cambia cuando se enganche Vapi/Retell/Bland.
-- ============================================================
CREATE TABLE IF NOT EXISTS dial_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- profiles(id), no auth.users(id): sigue la convención del módulo
  -- inmobiliario (property_listings.advisor_id) y permite embeber
  -- advisor:profiles(*) directo en las consultas.
  advisor_id   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  mode         TEXT NOT NULL DEFAULT 'manual'
                 CHECK (mode IN ('manual', 'ia')),
  status       TEXT NOT NULL DEFAULT 'activa'
                 CHECK (status IN ('activa', 'pausada', 'finalizada')),
  -- Intento en vuelo. NULL = no hay llamada activa, la sesión puede
  -- marcar el siguiente. Es el candado que evita dos llamadas
  -- simultáneas en una misma sesión.
  active_attempt_id UUID,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at     TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dial_sessions_account_status
  ON dial_sessions(account_id, status);

ALTER TABLE dial_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dial_sessions_select ON dial_sessions;
CREATE POLICY dial_sessions_select ON dial_sessions FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS dial_sessions_insert ON dial_sessions;
CREATE POLICY dial_sessions_insert ON dial_sessions FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS dial_sessions_update ON dial_sessions;
CREATE POLICY dial_sessions_update ON dial_sessions FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS dial_sessions_delete ON dial_sessions;
CREATE POLICY dial_sessions_delete ON dial_sessions FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON dial_sessions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON dial_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- dial_queue_items — los leads encolados en una sesión.
--
-- `phones` es una INSTANTÁNEA ordenada de los números a intentar,
-- congelada al encolar. Si alguien edita el contacto a mitad de
-- sesión, la cola no cambia bajo los pies del asesor. `phone_index`
-- apunta al siguiente número por marcar dentro de ese arreglo.
-- ============================================================
CREATE TABLE IF NOT EXISTS dial_queue_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES dial_sessions(id) ON DELETE CASCADE,
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- SET NULL, no CASCADE: borrar un contacto no debe borrar el
  -- historial de que se le intentó llamar (misma decisión que
  -- deals.contact_id en 004).
  contact_id   UUID REFERENCES contacts(id) ON DELETE SET NULL,
  phones       TEXT[] NOT NULL DEFAULT '{}',
  phone_index  INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pendiente'
                 CHECK (status IN ('pendiente', 'en_progreso', 'completado', 'omitido')),
  -- Motivo cuando status='omitido' (ej. 'lista_no_llamar', 'sin_numero').
  skip_reason  TEXT,
  priority     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice que sirve al reclamo de cola: buscar el siguiente pendiente
-- de una sesión, por prioridad y antigüedad.
CREATE INDEX IF NOT EXISTS idx_dial_queue_items_next
  ON dial_queue_items(session_id, priority DESC, created_at ASC)
  WHERE status = 'pendiente';

CREATE INDEX IF NOT EXISTS idx_dial_queue_items_account
  ON dial_queue_items(account_id);

ALTER TABLE dial_queue_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dial_queue_items_select ON dial_queue_items;
CREATE POLICY dial_queue_items_select ON dial_queue_items FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS dial_queue_items_insert ON dial_queue_items;
CREATE POLICY dial_queue_items_insert ON dial_queue_items FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS dial_queue_items_update ON dial_queue_items;
CREATE POLICY dial_queue_items_update ON dial_queue_items FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS dial_queue_items_delete ON dial_queue_items;
CREATE POLICY dial_queue_items_delete ON dial_queue_items FOR DELETE
  USING (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at ON dial_queue_items;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON dial_queue_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- call_attempts — un intento de marcado a un número concreto.
--
-- La mayoría no contestan; esta es la tabla que más crece. Se
-- mantiene angosta a propósito (sin transcripción ni resumen).
-- ============================================================
CREATE TABLE IF NOT EXISTS call_attempts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_item_id  UUID NOT NULL REFERENCES dial_queue_items(id) ON DELETE CASCADE,
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone_dialed   TEXT NOT NULL,
  -- Identificador de Twilio. Único: llega en cada callback y es como
  -- se correlaciona la respuesta con el intento.
  twilio_call_sid TEXT UNIQUE,
  result         TEXT
                   CHECK (result IN ('contesto', 'no_contesto', 'ocupado', 'fallo', 'cancelado')),
  duration_sec   INTEGER,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_call_attempts_queue_item
  ON call_attempts(queue_item_id);
CREATE INDEX IF NOT EXISTS idx_call_attempts_account
  ON call_attempts(account_id, started_at DESC);

ALTER TABLE call_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS call_attempts_select ON call_attempts;
CREATE POLICY call_attempts_select ON call_attempts FOR SELECT
  USING (is_account_member(account_id));

-- Escrituras solo por el service-role desde los webhooks de Twilio;
-- ningún usuario del dashboard inserta intentos a mano.
DROP POLICY IF EXISTS call_attempts_insert ON call_attempts;
DROP POLICY IF EXISTS call_attempts_update ON call_attempts;
DROP POLICY IF EXISTS call_attempts_delete ON call_attempts;

-- ============================================================
-- call_results — el registro de una llamada CONTESTADA.
--
-- Una fila por intento contestado. Aquí viven la grabación, la
-- transcripción y lo que produce la IA.
--
-- `transcription_status` desacopla el webhook del trabajo pesado:
-- el callback de grabación solo guarda la URL y deja 'pendiente';
-- un cron drena la cola. Descargar un audio de 5 min + Whisper + LLM
-- puede exceder el límite de función de Vercel, así que hacerlo en
-- el propio callback sería frágil.
-- ============================================================
CREATE TABLE IF NOT EXISTS call_results (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id    UUID NOT NULL UNIQUE REFERENCES call_attempts(id) ON DELETE CASCADE,
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id    UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- NULL cuando la llamada la sostuvo la IA, no un humano.
  advisor_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  mode          TEXT NOT NULL DEFAULT 'manual'
                  CHECK (mode IN ('manual', 'ia')),
  recording_url TEXT,
  transcript    TEXT,
  ai_summary    TEXT,
  -- Valores acotados para poder filtrar y graficar. El prompt pide
  -- explícitamente uno de estos.
  ai_recommendation TEXT
                  CHECK (ai_recommendation IN
                    ('alta_intencion', 'pedir_info', 'reagendar', 'no_interesado', 'no_calificado')),
  transcription_status TEXT NOT NULL DEFAULT 'pendiente'
                  CHECK (transcription_status IN
                    ('pendiente', 'procesando', 'listo', 'fallo', 'omitido')),
  transcription_error TEXT,
  duration_sec  INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_results_account_created
  ON call_results(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_results_contact
  ON call_results(contact_id, created_at DESC);
-- Parcial: el cron solo busca lo que falta transcribir.
CREATE INDEX IF NOT EXISTS idx_call_results_pending_transcription
  ON call_results(transcription_status)
  WHERE transcription_status = 'pendiente';

ALTER TABLE call_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS call_results_select ON call_results;
CREATE POLICY call_results_select ON call_results FOR SELECT
  USING (is_account_member(account_id));

-- Igual que call_attempts: solo escribe el service-role.
DROP POLICY IF EXISTS call_results_insert ON call_results;
DROP POLICY IF EXISTS call_results_update ON call_results;
DROP POLICY IF EXISTS call_results_delete ON call_results;

DROP TRIGGER IF EXISTS set_updated_at ON call_results;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON call_results
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Realtime: para que la bandeja de llamadas se actualice sola cuando
-- el cron termina de transcribir (mismo patrón que notifications, 027).
ALTER TABLE call_results REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'call_results'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE call_results;
  END IF;
END $$;

-- ============================================================
-- do_not_call — lista de exclusión por cuenta.
--
-- En Perú, Indecopi mantiene el registro "Gracias, no insista".
-- NO tiene API pública: es una consulta/descarga. Por eso esto es
-- una lista que la cuenta IMPORTA y que el motor consulta antes de
-- cada marcado — no un lookup en vivo. La UI lo dice explícito para
-- que nadie asuma que se sincroniza solo.
--
-- La clave es phone_normalized (solo dígitos), igual que la columna
-- generada de contacts (022), para que el cruce sea exacto.
-- ============================================================
CREATE TABLE IF NOT EXISTS do_not_call (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone_normalized TEXT NOT NULL,
  -- De dónde salió: 'indecopi', 'manual', 'importacion', etc.
  source           TEXT,
  notes            TEXT,
  added_by         UUID REFERENCES profiles(id) ON DELETE SET NULL,
  added_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, phone_normalized)
);

CREATE INDEX IF NOT EXISTS idx_do_not_call_account
  ON do_not_call(account_id);

ALTER TABLE do_not_call ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS do_not_call_select ON do_not_call;
CREATE POLICY do_not_call_select ON do_not_call FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS do_not_call_insert ON do_not_call;
CREATE POLICY do_not_call_insert ON do_not_call FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS do_not_call_update ON do_not_call;
CREATE POLICY do_not_call_update ON do_not_call FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS do_not_call_delete ON do_not_call;
CREATE POLICY do_not_call_delete ON do_not_call FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- claim_next_dial_item — reclamo atómico del siguiente lead.
--
-- Twilio reintenta callbacks, así que dos peticiones pueden intentar
-- avanzar la misma sesión a la vez. Sin candado, ambas marcarían y el
-- lead recibiría dos llamadas simultáneas.
--
-- FOR UPDATE SKIP LOCKED es el patrón canónico de cola en Postgres:
-- el segundo llamador no espera ni toma la misma fila, simplemente
-- no obtiene nada (que es exactamente lo correcto aquí — ya hay una
-- llamada en vuelo).
--
-- Además valida que la sesión esté 'activa' y sin `active_attempt_id`,
-- de modo que la comprobación "¿puedo marcar?" y el reclamo ocurran
-- en la misma transacción.
--
-- SECURITY DEFINER + grants solo a service_role: lo invocan los
-- webhooks de Twilio, que no tienen sesión de usuario. Mismo molde
-- que pick_round_robin_agent (034).
-- ============================================================
CREATE OR REPLACE FUNCTION claim_next_dial_item(p_session_id UUID)
RETURNS TABLE (
  item_id     UUID,
  contact_id  UUID,
  phones      TEXT[],
  phone_index INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_active UUID;
  v_item   RECORD;
BEGIN
  -- Bloquea la sesión primero: serializa a los callbacks concurrentes
  -- antes de que siquiera miren la cola.
  SELECT status, active_attempt_id INTO v_status, v_active
    FROM dial_sessions
    WHERE id = p_session_id
    FOR UPDATE;

  IF NOT FOUND OR v_status <> 'activa' OR v_active IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT q.id, q.contact_id, q.phones, q.phone_index INTO v_item
    FROM dial_queue_items q
    WHERE q.session_id = p_session_id
      AND q.status = 'pendiente'
    ORDER BY q.priority DESC, q.created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE dial_queue_items
    SET status = 'en_progreso', updated_at = NOW()
    WHERE id = v_item.id;

  item_id     := v_item.id;
  contact_id  := v_item.contact_id;
  phones      := v_item.phones;
  phone_index := v_item.phone_index;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION claim_next_dial_item(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_next_dial_item(UUID) FROM anon;
REVOKE ALL ON FUNCTION claim_next_dial_item(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_next_dial_item(UUID) TO service_role;
