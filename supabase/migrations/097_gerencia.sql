-- ============================================================
-- 097_gerencia.sql — Base de la app de Gerencia de Golden
--
-- Pedido de Bryce (2026-11-14): app de Gerencia para Golden Habitat, fase 1:
-- tablero (cobranza, caja y ventas de un vistazo, con metas del mes). Esta
-- migración se arma en tres tareas sobre el mismo archivo; aquí va la primera.
--
-- SOLO AGREGA objetos nuevos; no reemplaza ninguna función existente
-- (is_owner_or_gerencia, de la 084, se reutiliza tal cual). Idempotente: se
-- puede volver a correr. Crea:
--   1. gerencia_my_access(): {"rol": "gerencia" | null, "accountId": uuid | null}.
--      rol = 'gerencia' si is_owner_or_gerencia (dueño, super admin o área
--      gerencia); cualquier otro (cobranzas, marketing...) recibe null.
--   2. management_goals: meta del mes (cobranza en céntimos o ventas en
--      unidades), total de la cuenta (project_id NULL) o por proyecto. Con RLS:
--      solo gerencia lee; nadie escribe directo, solo por la RPC.
--   3. gerencia_set_goal(mes, proyecto, tipo, valor): pone, cambia o borra
--      (valor NULL o 0) una meta. El mes se normaliza al primer día.
--   4. gerencia_goals(mes): las metas de ese mes.
--
-- Casos: supabase/tests/097_casos.sql (correr DESPUÉS de aplicar esta; corre
-- como postgres en el SQL Editor y termina en ROLLBACK).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Acceso
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gerencia_my_access()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  RETURN jsonb_build_object(
    'rol', CASE WHEN a IS NOT NULL AND public.is_owner_or_gerencia(a) THEN 'gerencia' ELSE NULL END,
    'accountId', a);
END;
$$;
ALTER FUNCTION public.gerencia_my_access() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gerencia_my_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerencia_my_access() TO authenticated;

-- ------------------------------------------------------------
-- 2. Metas del mes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.management_goals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  month        date NOT NULL CHECK (month = date_trunc('month', month)::date),
  project_id   uuid REFERENCES public.real_estate_projects(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('cobranza', 'ventas')),
  amount_cents bigint CHECK (amount_cents > 0),
  units        integer CHECK (units > 0),
  set_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT management_goals_kind_value CHECK (
    (kind = 'cobranza' AND amount_cents IS NOT NULL AND units IS NULL)
    OR (kind = 'ventas' AND units IS NOT NULL AND amount_cents IS NULL)),
  CONSTRAINT management_goals_unique UNIQUE NULLS NOT DISTINCT (account_id, month, project_id, kind)
);

ALTER TABLE public.management_goals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.management_goals FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.management_goals FROM authenticated;
GRANT SELECT ON public.management_goals TO authenticated;

DROP POLICY IF EXISTS management_goals_select ON public.management_goals;
CREATE POLICY management_goals_select ON public.management_goals FOR SELECT
  USING (public.is_owner_or_gerencia(account_id));

-- ------------------------------------------------------------
-- 3. Poner, cambiar o borrar una meta
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gerencia_set_goal(p_month date, p_project uuid, p_kind text, p_value bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_month date;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT public.is_owner_or_gerencia(a) THEN
    RAISE EXCEPTION 'Solo gerencia' USING ERRCODE = '42501';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('cobranza', 'ventas') THEN
    RAISE EXCEPTION 'Tipo de meta no válido' USING ERRCODE = '22023';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'Mes no válido' USING ERRCODE = '22023';
  END IF;
  IF p_value IS NOT NULL AND p_value < 0 THEN
    RAISE EXCEPTION 'Valor no válido' USING ERRCODE = '22023';
  END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.real_estate_projects r WHERE r.id = p_project AND r.account_id = a) THEN
    RAISE EXCEPTION 'Proyecto no válido' USING ERRCODE = '22023';
  END IF;
  v_month := date_trunc('month', p_month)::date;

  IF p_value IS NULL OR p_value = 0 THEN
    DELETE FROM public.management_goals g
     WHERE g.account_id = a AND g.month = v_month AND g.kind = p_kind
       AND g.project_id IS NOT DISTINCT FROM p_project;
    RETURN;
  END IF;

  IF p_kind = 'ventas' AND p_value > 2147483647 THEN
    RAISE EXCEPTION 'Valor no válido' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.management_goals (account_id, month, project_id, kind, amount_cents, units, set_by)
  VALUES (a, v_month, p_project, p_kind,
          CASE WHEN p_kind = 'cobranza' THEN p_value END,
          CASE WHEN p_kind = 'ventas' THEN p_value::integer END,
          auth.uid())
  ON CONFLICT ON CONSTRAINT management_goals_unique DO UPDATE
    SET amount_cents = EXCLUDED.amount_cents, units = EXCLUDED.units,
        set_by = EXCLUDED.set_by, updated_at = now();
END;
$$;
ALTER FUNCTION public.gerencia_set_goal(date, uuid, text, bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gerencia_set_goal(date, uuid, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerencia_set_goal(date, uuid, text, bigint) TO authenticated;

-- ------------------------------------------------------------
-- 4. Metas de un mes
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.gerencia_goals(p_month date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR NOT public.is_owner_or_gerencia(a) THEN
    RAISE EXCEPTION 'Solo gerencia' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'projectId', g.project_id,
             'kind', g.kind,
             'value', COALESCE(g.amount_cents, g.units::bigint))
           ORDER BY g.kind, g.project_id NULLS FIRST)
      FROM public.management_goals g
     WHERE g.account_id = a
       AND g.month = date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'America/Lima')::date))::date
  ), '[]'::jsonb);
END;
$$;
ALTER FUNCTION public.gerencia_goals(date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gerencia_goals(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gerencia_goals(date) TO authenticated;
