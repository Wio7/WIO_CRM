-- ============================================================
-- 088_golden_separacion_avisos.sql — un solo aviso por separación aprobada
--
-- Cuando se aprueba una separación en la Golden App, el CRM manda un
-- push a todo el equipo (/api/golden/separacion-aprobada). Esta tabla
-- es el candado de idempotencia: la primera llamada para una solicitud
-- inserta su fila y envía; cualquier repetición (doble toque, reintento
-- de red, otro dispositivo) choca con la clave primaria y no envía nada.
--
-- `solicitud_id` es el id de gh_lotes_solicitudes en la base del
-- CATÁLOGO (otra base), por eso no hay llave foránea hacia ella.
--
-- Sin políticas a propósito: sólo escribe el servidor con la service
-- role. Idempotente — se puede volver a correr.
-- ============================================================
CREATE TABLE IF NOT EXISTS golden_separacion_avisos (
  solicitud_id uuid PRIMARY KEY,
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  enviado_por  uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE golden_separacion_avisos ENABLE ROW LEVEL SECURITY;
