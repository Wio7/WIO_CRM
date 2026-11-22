-- 108 EMPRESAS POR PROYECTO + TIPO DE SEPARACION + AVISO DE 7 DIAS. WIO_CRM main.
-- Correr en el SQL Editor de wioCRM (WioSuite). Es idempotente: se puede volver a
-- correr sin dañar nada. No toca gh_lotes_resolver ni libera ningún lote.

-- ============================================================
-- 108_empresas_y_separaciones.sql
--
-- Pedido de Bryce (2026-11-22), a partir de la revisión con Celeste (2026-11-21):
--
--   1. EMPRESA. company_key acepta también 'terceros' (proyectos que Golden solo
--      promueve, como Vista Mar, y casas de entrega inmediata a nombre de
--      personas). Columna nueva real_estate_projects.propietario (texto corto)
--      para esas casas. Se asigna, solo donde está vacío y en la cuenta
--      'Golden Habitat': Rinconada de Huacachina = golden, Vista Mar = terceros.
--      Puesta del Sol sigue en NULL: la etapa 1 es Golden y la 2 a 5 son Dream, y
--      en el sistema es un solo proyecto (se decide aparte). Menorca, en NULL.
--
--   2. TIPO DE SEPARACION. gh_lotes_solicitudes.tipo_separacion:
--      'minima' | 'inicial_completa' | 'contado'. Nullable: las separaciones
--      viejas quedan sin tipo. La Golden App lo empieza a mandar en otra entrega.
--
--   3. AVISO DE 7 DIAS. gh_separaciones_por_vencer(p_dias) lista las
--      separaciones aprobadas, vigentes, con el lote todavía 'separado', que no
--      llegaron a expediente legal (= la inicial no se completó) y que tienen
--      más de p_dias días desde la aprobación. Incluye las de tipo 'minima' y
--      las que no tienen tipo (viejas). Solo LISTA: liberar sigue siendo a mano
--      con gh_lote_cambio_manual(..., 'liberar', 'falta_pago'). Decisión de
--      Bryce 2026-11-22: aviso y botón, nunca liberar solo.
--      La pueden usar los aprobadores (gh_puede_resolver) y dueño/gerencia de la
--      cuenta Golden Habitat.
--
-- Casos: traspaso-catalogo/probar-108.mjs (PGlite, base falsa).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Empresa por proyecto
-- ------------------------------------------------------------
ALTER TABLE public.real_estate_projects
  DROP CONSTRAINT IF EXISTS real_estate_projects_company_key_check;
ALTER TABLE public.real_estate_projects
  ADD CONSTRAINT real_estate_projects_company_key_check
  CHECK (company_key IN ('golden', 'dream', 'terceros'));

ALTER TABLE public.real_estate_projects
  ADD COLUMN IF NOT EXISTS propietario text;
ALTER TABLE public.real_estate_projects
  DROP CONSTRAINT IF EXISTS real_estate_projects_propietario_check;
ALTER TABLE public.real_estate_projects
  ADD CONSTRAINT real_estate_projects_propietario_check
  CHECK (propietario IS NULL OR char_length(btrim(propietario)) BETWEEN 2 AND 120);

DO $$
DECLARE
  n integer;
BEGIN
  UPDATE public.real_estate_projects r
     SET company_key = v.k
    FROM (VALUES
      ('%rinconada%huacachina%', 'golden'),
      ('%vista mar%', 'terceros')
    ) AS v(patron, k)
   WHERE lower(r.name) LIKE v.patron
     AND r.company_key IS NULL
     AND r.account_id IN (SELECT id FROM public.accounts WHERE name = 'Golden Habitat');
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '108: % proyecto(s) con empresa asignada en esta corrida', n;
END;
$$;

-- ------------------------------------------------------------
-- 2. Tipo de separación
-- ------------------------------------------------------------
ALTER TABLE public.gh_lotes_solicitudes
  ADD COLUMN IF NOT EXISTS tipo_separacion text;
ALTER TABLE public.gh_lotes_solicitudes
  DROP CONSTRAINT IF EXISTS gh_lotes_sol_tipo_separacion_check;
ALTER TABLE public.gh_lotes_solicitudes
  ADD CONSTRAINT gh_lotes_sol_tipo_separacion_check
  CHECK (tipo_separacion IS NULL OR tipo_separacion IN ('minima', 'inicial_completa', 'contado'));

-- ------------------------------------------------------------
-- 3. Separaciones por vencer (solo lista; nadie libera solo)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gh_separaciones_por_vencer(p_dias integer DEFAULT 7)
RETURNS TABLE (
  solicitud       uuid,
  proyecto        text,
  lote            text,
  cliente_nombre  text,
  asesor          text,
  jefe_ventas     text,
  monto           numeric,
  moneda          text,
  tipo_separacion text,
  aprobada_el     timestamptz,
  dias            integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_golden uuid;
BEGIN
  SELECT id INTO v_golden FROM public.accounts WHERE name = 'Golden Habitat' LIMIT 1;
  IF NOT (coalesce(public.gh_puede_resolver(), false)
          OR (v_golden IS NOT NULL AND coalesce(public.is_owner_or_gerencia(v_golden), false))) THEN
    RAISE EXCEPTION 'SIN_PERMISO' USING errcode = '42501',
      hint = 'Esta lista es de los aprobadores y de gerencia.';
  END IF;
  IF p_dias IS NULL OR p_dias < 1 OR p_dias > 60 THEN
    RAISE EXCEPTION 'DIAS_INVALIDOS' USING hint = 'Usa entre 1 y 60 días.';
  END IF;

  RETURN QUERY
  SELECT s.id, s.proyecto, s.lote, s.cliente_nombre, s.asesor, s.jefe_ventas,
         s.monto, s.moneda, s.tipo_separacion,
         coalesce(s.resuelta, s.creada),
         (extract(epoch FROM (now() - coalesce(s.resuelta, s.creada))) / 86400)::integer
    FROM public.gh_lotes_solicitudes s
    JOIN public.gh_lotes_estado e ON e.proyecto = s.proyecto AND e.lote = s.lote
   WHERE s.estado = 'aprobada'
     AND e.estado = 'separado'
     AND (s.tipo_separacion IS NULL OR s.tipo_separacion = 'minima')
     AND coalesce(s.resuelta, s.creada) < now() - make_interval(days => p_dias)
     AND NOT EXISTS (
           SELECT 1 FROM public.gh_separacion_etapas t
            WHERE t.solicitud = s.id AND t.etapa = 'expediente_legal')
     AND public.gh_solicitud_vigente(s.id)
   ORDER BY coalesce(s.resuelta, s.creada);
END;
$$;

ALTER FUNCTION public.gh_separaciones_por_vencer(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gh_separaciones_por_vencer(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gh_separaciones_por_vencer(integer) TO authenticated;

-- Para revisar después de correrla (solo lectura):
-- select name, company_key, propietario from real_estate_projects
--  where account_id in (select id from accounts where name = 'Golden Habitat') order by name;
