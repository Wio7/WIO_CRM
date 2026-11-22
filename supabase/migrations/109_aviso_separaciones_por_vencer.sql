-- 109 AVISO DIARIO DE SEPARACIONES POR VENCER. WIO_CRM main.
-- Correr en el SQL Editor de wioCRM (WioSuite), DESPUES de la 108.
-- Es idempotente. No libera ningún lote.

-- ============================================================
-- 109_aviso_separaciones_por_vencer.sql
--
-- El aviso diario (cron de Vercel en WIO_CRM) corre sin sesión de usuario, así
-- que no puede usar gh_separaciones_por_vencer (pide aprobador o gerencia).
-- Esta función es SOLO para service_role (el servidor) y devuelve:
--   - cuántas separaciones pasaron p_dias sin llegar a expediente legal
--     (la misma regla de la 108, reutilizada tal cual), y
--   - a quién avisar: los perfiles de la cuenta 'Golden Habitat' cuyo correo
--     está en gh_equipo con aprueba_separaciones = true o área 'dueno'.
-- No devuelve datos del cliente.
-- ============================================================

CREATE OR REPLACE FUNCTION public.gh_por_vencer_aviso(p_dias integer DEFAULT 7)
RETURNS TABLE (account_id uuid, cantidad integer, destinatarios uuid[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_golden uuid;
  v_cant integer;
BEGIN
  IF p_dias IS NULL OR p_dias < 1 OR p_dias > 60 THEN
    RAISE EXCEPTION 'DIAS_INVALIDOS';
  END IF;
  SELECT a.id INTO v_golden FROM public.accounts a WHERE a.name = 'Golden Habitat' LIMIT 1;
  IF v_golden IS NULL THEN RETURN; END IF;

  SELECT count(*)::integer INTO v_cant
    FROM public.gh_lotes_solicitudes s
    JOIN public.gh_lotes_estado e ON e.proyecto = s.proyecto AND e.lote = s.lote
   WHERE s.estado = 'aprobada'
     AND e.estado = 'separado'
     AND (s.tipo_separacion IS NULL OR s.tipo_separacion = 'minima')
     AND coalesce(s.resuelta, s.creada) < now() - make_interval(days => p_dias)
     AND NOT EXISTS (
           SELECT 1 FROM public.gh_separacion_etapas t
            WHERE t.solicitud = s.id AND t.etapa = 'expediente_legal')
     AND public.gh_solicitud_vigente(s.id);

  RETURN QUERY
  SELECT v_golden, v_cant,
         coalesce(array_agg(DISTINCT p.user_id) FILTER (WHERE p.user_id IS NOT NULL), '{}'::uuid[])
    FROM public.profiles p
    JOIN public.gh_equipo q ON q.correo = lower(p.email)
   WHERE p.account_id = v_golden
     AND (q.aprueba_separaciones OR q.area = 'dueno');
END;
$$;

ALTER FUNCTION public.gh_por_vencer_aviso(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gh_por_vencer_aviso(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gh_por_vencer_aviso(integer) TO service_role;
