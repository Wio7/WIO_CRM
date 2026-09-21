-- ============================================================
-- 060_asesor_sin_area.sql — un asesor es un asesor, sin más
--
-- En Golden el área es el DEPARTAMENTO que alguien dirige: marketing,
-- legal, cobranzas, ventas. Quien dirige es un administrador. Un asesor
-- inmobiliario no dirige nada: es un asesor y punto, y ponerle "área:
-- ventas" era papeleo que no significaba nada... salvo que sí
-- significaba, y mal: el reparto buscaba `area = 'ventas'` y a un asesor
-- sin esa etiqueta no le caía jamás una conversación.
--
-- La regla que queda: en ventas entra quien tenga `area = 'ventas'` (el
-- jefe) Y TAMBIÉN todo asesor sin área, que es la plantilla de la calle.
-- En las demás áreas no cambia nada: a cobranzas o a legal se entra
-- porque alguien te puso ahí.
--
-- Idempotente — se puede volver a correr.
-- ============================================================

CREATE OR REPLACE FUNCTION pick_area_agent(p_account_id UUID, p_area TEXT)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- asesor sin area: en ventas cuenta el asesor que no tiene área puesta.
  SELECT p.user_id
    FROM profiles p
   WHERE p.account_id = p_account_id
     AND (
       p.area = p_area
       OR (p_area = 'ventas' AND p.area IS NULL AND p.account_role = 'agent')
     )
   ORDER BY (
     SELECT count(*)
       FROM conversations c
      WHERE c.account_id = p_account_id
        AND c.assigned_agent_id = p.user_id
        AND c.status <> 'closed'
   ), p.created_at
   LIMIT 1;
$$;

ALTER FUNCTION pick_area_agent(UUID, TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION pick_area_agent(UUID, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION pick_area_agent(UUID, TEXT) IS
  'El miembro menos cargado de un área. En ventas entran el jefe de ventas y los asesores sin área, que son la plantilla de la calle.';

-- ============================================================
-- Y los que ya tenían el área puesta a mano
--
-- Se les quita: a partir de aquí un asesor no lleva área, y dejar la
-- etiqueta vieja sólo confunde a quien mire la pantalla de Equipo.
-- Los administradores no se tocan — la suya es su cargo.
-- ============================================================
UPDATE profiles
SET area = NULL
WHERE account_role = 'agent'
  AND area IS NOT NULL;
