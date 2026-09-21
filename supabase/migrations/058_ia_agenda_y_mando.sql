-- ============================================================
-- 058_ia_agenda_y_mando.sql — la IA agenda, y sólo el asesor la calla
--
-- Dos cambios de fondo en cómo trabaja la IA que atiende a los clientes.
-- Los dos son interruptores por cuenta y nacen APAGADOS: Aurex y Luis
-- siguen exactamente igual. Se encienden aquí sólo para Golden.
--
--   1. `ai_books_appointments`
--      Hoy, en cuanto toca agendar, la IA dice "te paso con un asesor" y
--      ahí se acaba todo: el cliente espera y el asesor se entera cuando
--      abre la app. Con esto encendido, la IA pregunta qué día y qué hora
--      le quedan bien, mira la agenda central del equipo de ventas
--      (`staff_availability` + `appointments`, migración 049), reserva la
--      cita en un hueco real, le asigna ESE asesor a la conversación y le
--      hace sonar el celular. El cliente sale de la conversación con día
--      y hora, no con una promesa.
--
--      Sólo entran al reparto los asesores que YA publicaron sus
--      horarios: ofrecer la hora de alguien que no ha dicho cuándo
--      trabaja es inventarse una cita.
--
--   2. `ai_stops_only_on_button`
--      La regla de la 041 callaba a la IA en cuanto cualquier persona del
--      equipo escribía en el hilo. Eso la apagaba sola y sin avisar, y
--      deja al cliente a oscuras si el asesor escribió una línea y se
--      fue. Con esto encendido, la IA no decide nunca callarse: sigue
--      contestando hasta que un asesor toca "Yo" en la cabecera del chat
--      (`ai_autoreply_disabled`, que es lo único que la para).
--
--      Ojo para quien lea esto luego: con el interruptor encendido, un
--      asesor que conteste sin tomar la conversación se cruzará con la
--      IA. Es a propósito — el equipo prefiere eso a que la IA se apague
--      sola— y se avisa en la pantalla del chat.
--
-- Idempotente — se puede volver a correr.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS ai_books_appointments BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_stops_only_on_button BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN accounts.ai_books_appointments IS
  'La IA ofrece las horas libres del equipo y reserva la cita ella misma, en vez de pasar la conversación a un humano.';
COMMENT ON COLUMN accounts.ai_stops_only_on_button IS
  'La IA sigue contestando aunque el equipo escriba: sólo la calla el botón "Yo" del chat.';

UPDATE accounts
SET ai_books_appointments = true,
    ai_stops_only_on_button = true
WHERE name ILIKE 'Golden%';

-- ============================================================
-- Una cita puede nacer de la IA
--
-- La 049 sólo admitía 'cliente' (la agendó él desde la app) o 'equipo'
-- (la agendó un asesor). Ahora hay un tercer origen y conviene poder
-- distinguirlo: saber cuántas citas trajo la IA es media respuesta a si
-- vale la pena. El CHECK se rehace porque no se puede ampliar en sitio.
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.appointments') IS NOT NULL THEN
    ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_created_by_check;
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_created_by_check
      CHECK (created_by IN ('cliente', 'equipo', 'ia'));
  END IF;
END $$;

-- ============================================================
-- Las conversaciones que la IA se apagó a sí misma
--
-- Hasta hoy, cada vez que no supo seguir, la IA puso
-- `ai_autoreply_disabled = true` y nadie lo deshizo: son hilos mudos,
-- clientes que escribieron "¿hola?" sin que apareciera nadie. Como a
-- partir de ahora sólo apaga el botón, se reabren los que ningún humano
-- llegó a tomar, es decir aquellos donde el equipo nunca escribió.
-- Los que un asesor sí contestó se quedan como están: ésos los tomó
-- alguien de verdad.
-- ============================================================
UPDATE conversations c
SET ai_autoreply_disabled = false,
    ai_reply_count = 0,
    ai_resumed_at = NOW()
WHERE c.ai_autoreply_disabled
  AND c.account_id IN (SELECT id FROM accounts WHERE name ILIKE 'Golden%')
  AND NOT EXISTS (
    SELECT 1 FROM messages m
     WHERE m.conversation_id = c.id
       AND m.sender_type = 'agent'
  );
