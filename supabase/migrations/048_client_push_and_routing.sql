-- ============================================================
-- 048_client_push_and_routing.sql — que al cliente le suene el celular,
-- y que su mensaje caiga en el área que le toca.
--
-- Dos cosas que faltaban para que el chat de la app sea un canal de
-- verdad y no una pantalla bonita:
--
--   1. Avisos al cliente. `push_subscriptions` (039) cuelga de
--      auth.users, y un cliente no tiene usuario: entra con celular y
--      DNI. Necesita su propia tabla, colgada del contacto.
--
--   2. A quién se le asigna. En Golden el asesor vende y suelta: al que
--      ya es cliente lo lleva COBRANZAS, no quien se lo vendió. El
--      reparto redondo de 039 no sabe de áreas, así que aquí va un
--      elector por área.
--
-- Idempotente — se puede volver a correr.
-- ============================================================

-- ============================================================
-- 1. Los teléfonos del cliente
--
-- Una fila por navegador. `endpoint` es único: si el mismo teléfono
-- vuelve a suscribirse (o cambia de dueño), se repunta la fila en vez de
-- fallar. Sin políticas a propósito: aquí sólo escribe el servidor con
-- la service role, porque el cliente no tiene sesión de base con la que
-- pedir nada.
-- ============================================================
CREATE TABLE IF NOT EXISTS client_push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  endpoint     text NOT NULL UNIQUE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_push_contact
  ON client_push_subscriptions(contact_id);

ALTER TABLE client_push_subscriptions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. El asesor de un área, el menos cargado
--
-- Devuelve el `user_id` del miembro de esa área con menos
-- conversaciones abiertas encima, y NULL si en el área no hay nadie —
-- que es la respuesta correcta cuando todavía no repartieron los
-- cargos: quien decide entonces es el reparto de siempre (039), no un
-- error.
--
-- Cuenta conversaciones abiertas en vez de llevar un contador aparte:
-- se reequilibra solo cuando alguien cierra las suyas, y no hay estado
-- que se pueda desincronizar.
-- ============================================================
CREATE OR REPLACE FUNCTION pick_area_agent(p_account_id UUID, p_area TEXT)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.user_id
    FROM profiles p
   WHERE p.account_id = p_account_id
     AND p.area = p_area
   ORDER BY (
     SELECT count(*)
       FROM conversations c
      WHERE c.account_id = p_account_id
        AND c.assigned_agent_id = p.user_id
        AND c.status <> 'closed'
   ), p.created_at
   LIMIT 1;
$$;

COMMENT ON FUNCTION pick_area_agent(UUID, TEXT) IS
  'El miembro menos cargado de un área (marketing | legal | cobranzas | ventas), o NULL si esa área está vacía.';
