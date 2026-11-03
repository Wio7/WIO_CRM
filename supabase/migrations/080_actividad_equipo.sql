-- ============================================================
-- 080 · Cuántos mensajes movió cada asesor en un periodo
--
-- El agente de WhatsApp responde "¿cuántos mensajes le llegaron a Sara?".
-- Contarlo desde el servidor bajaría miles de mensajes en cada pregunta, así
-- que se cuenta aquí. Es la misma regla de la pantalla Control: un mensaje se
-- atribuye a quien tiene hoy el chat, y sólo cuentan los del cliente y los del
-- asesor (la IA no).
--
-- Sólo para dueños y administradores. Idempotente.
-- ============================================================

CREATE OR REPLACE FUNCTION public.actividad_del_equipo(
  p_cuenta uuid,
  p_desde timestamptz,
  p_hasta timestamptz
)
RETURNS TABLE (user_id uuid, recibidos bigint, enviados bigint, chats bigint, dias text[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_account_member(p_cuenta, 'admin') THEN
    RAISE EXCEPTION 'Sin acceso a la actividad del equipo' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT c.assigned_agent_id,
         count(*) FILTER (WHERE m.sender_type = 'customer'),
         count(*) FILTER (WHERE m.sender_type = 'agent'),
         count(DISTINCT c.id),
         COALESCE(
           array_agg(DISTINCT to_char(m.created_at AT TIME ZONE 'America/Lima', 'YYYY-MM-DD'))
             FILTER (WHERE m.sender_type = 'agent'),
           '{}'::text[]
         )
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
   WHERE c.account_id = p_cuenta
     AND c.assigned_agent_id IS NOT NULL
     AND m.sender_type IN ('customer', 'agent')
     AND m.created_at >= p_desde
     AND m.created_at < p_hasta
   GROUP BY c.assigned_agent_id;
END;
$$;

REVOKE ALL ON FUNCTION public.actividad_del_equipo(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.actividad_del_equipo(uuid, timestamptz, timestamptz) TO authenticated;
