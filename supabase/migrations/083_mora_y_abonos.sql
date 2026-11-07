-- ============================================================
-- 083_mora_y_abonos.sql — Mora y abonos a capital (Wio Suite, ERP fase 1)
--
-- 1. Mora configurable por cuenta (apagada por defecto). Es informativa:
--    la app la calcula y la muestra en Cobranzas; aquí solo se guarda la
--    regla. La configuran los admins de la cuenta (policy accounts_update).
-- 2. Abono a capital: el cliente adelanta plata y bajan las cuotas futuras
--    ("reducir_cuota") o se cubren las últimas ("reducir_plazo"). Cada
--    abono queda en plan_prepayments con el detalle antes/después.
--    Las cuotas cubiertas por completo pasan a estado 'adelantada'.
-- 3. payment_plan_balances suma los abonos a paid_amount (y los expone en
--    prepaid_amount) para que pagado + saldo = total en todas las pantallas.
--
-- Diseño: docs/superpowers/specs/2026-11-07-mora-y-abonos-design.md
-- Idempotente — se puede volver a correr.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Mora por cuenta
-- ------------------------------------------------------------
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS late_fee_type text NOT NULL DEFAULT 'ninguna',
  ADD COLUMN IF NOT EXISTS late_fee_value numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS late_fee_grace_days integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_late_fee_valid') THEN
    ALTER TABLE public.accounts ADD CONSTRAINT accounts_late_fee_valid CHECK (
      late_fee_type IN ('ninguna', 'fija', 'porcentaje_mensual')
      AND late_fee_value >= 0
      AND (late_fee_type <> 'porcentaje_mensual' OR late_fee_value <= 100)
      AND late_fee_grace_days BETWEEN 0 AND 365
    );
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. Estado 'adelantada' para cuotas cubiertas por un abono
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'installments_status_check') THEN
    ALTER TABLE public.installments DROP CONSTRAINT installments_status_check;
  END IF;
  ALTER TABLE public.installments ADD CONSTRAINT installments_status_check
    CHECK (status IN ('pendiente', 'pagada', 'condonada', 'adelantada'));
END $$;

-- ------------------------------------------------------------
-- 3. Registro de abonos
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.plan_prepayments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  plan_id     uuid NOT NULL REFERENCES public.payment_plans(id) ON DELETE CASCADE,
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  mode        text NOT NULL CHECK (mode IN ('reducir_plazo', 'reducir_cuota')),
  method      text,
  reference   text,
  note        text CHECK (note IS NULL OR char_length(note) <= 1000),
  -- [{installment_id, number, before, after}] para auditar o deshacer a mano.
  changes     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by  uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plan_prepayments_plan
  ON public.plan_prepayments(plan_id, created_at DESC);

ALTER TABLE public.plan_prepayments ENABLE ROW LEVEL SECURITY;

-- Mismo criterio que payment_plans (043). Se escribe solo por el RPC de
-- abajo (que corre con los permisos de quien llama); no hay policy de
-- UPDATE: un abono no se edita, se corrige con otro movimiento.
DROP POLICY IF EXISTS plan_prepayments_select ON public.plan_prepayments;
CREATE POLICY plan_prepayments_select ON public.plan_prepayments FOR SELECT
  USING (public.is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS plan_prepayments_insert ON public.plan_prepayments;
CREATE POLICY plan_prepayments_insert ON public.plan_prepayments FOR INSERT
  WITH CHECK (
    public.is_account_member(account_id, 'agent')
    AND created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.payment_plans p
      WHERE p.id = plan_prepayments.plan_id AND p.account_id = plan_prepayments.account_id
    )
  );

DROP POLICY IF EXISTS plan_prepayments_delete ON public.plan_prepayments;
CREATE POLICY plan_prepayments_delete ON public.plan_prepayments FOR DELETE
  USING (public.is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- 4. RPC: aplicar un abono en una sola transacción
--
-- La app calcula los montos nuevos (src/lib/prepayments.ts, con pruebas)
-- y la base vuelve a validar todo: cuotas del plan, pendientes, que
-- vencen de hoy (Lima) en adelante, que ninguna suba ni quede negativa y
-- que lo rebajado sume exactamente el abono. SECURITY INVOKER: los
-- permisos (RLS de installments y plan_prepayments) son los de quien llama.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_prepayment(
  p_plan_id   uuid,
  p_amount    numeric,
  p_mode      text,
  p_changes   jsonb,
  p_method    text DEFAULT NULL,
  p_reference text DEFAULT NULL,
  p_note      text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_plan     payment_plans%ROWTYPE;
  v_today    date := (now() AT TIME ZONE 'America/Lima')::date;
  v_change   jsonb;
  v_inst     installments%ROWTYPE;
  v_new      numeric(12,2);
  v_total    numeric(12,2) := 0;
  v_audit    jsonb := '[]'::jsonb;
  v_id       uuid;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'El abono debe ser mayor a cero';
  END IF;
  IF p_mode NOT IN ('reducir_plazo', 'reducir_cuota') THEN
    RAISE EXCEPTION 'Modo de abono no válido';
  END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'array' OR jsonb_array_length(p_changes) = 0 THEN
    RAISE EXCEPTION 'El abono no cambia ninguna cuota';
  END IF;

  -- Bloquea el plan: dos abonos a la vez sobre el mismo plan no se cruzan.
  SELECT * INTO v_plan FROM payment_plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Plan no encontrado';
  END IF;
  IF v_plan.status <> 'activo' THEN
    RAISE EXCEPTION 'Solo se abona a planes activos';
  END IF;
  IF NOT public.is_account_member(v_plan.account_id, 'agent') THEN
    RAISE EXCEPTION 'Sin permiso sobre este plan';
  END IF;

  FOR v_change IN SELECT * FROM jsonb_array_elements(p_changes) LOOP
    SELECT * INTO v_inst FROM installments
     WHERE id = (v_change->>'id')::uuid AND plan_id = p_plan_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Una de las cuotas no es de este plan';
    END IF;
    IF v_inst.status <> 'pendiente' THEN
      RAISE EXCEPTION 'La cuota % ya no está pendiente', v_inst.number;
    END IF;
    IF v_inst.due_date < v_today THEN
      RAISE EXCEPTION 'La cuota % ya venció; se paga, no se abona', v_inst.number;
    END IF;
    v_new := round((v_change->>'newAmount')::numeric, 2);
    IF v_new IS NULL OR v_new < 0 OR v_new >= v_inst.amount THEN
      RAISE EXCEPTION 'Monto nuevo no válido para la cuota %', v_inst.number;
    END IF;

    v_total := v_total + (v_inst.amount - v_new);
    v_audit := v_audit || jsonb_build_object(
      'installment_id', v_inst.id, 'number', v_inst.number,
      'before', v_inst.amount, 'after', v_new
    );

    UPDATE installments
       SET amount = v_new,
           status = CASE WHEN v_new = 0 THEN 'adelantada' ELSE status END,
           updated_at = now()
     WHERE id = v_inst.id;
  END LOOP;

  IF v_total <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'Lo rebajado (%) no coincide con el abono (%)', v_total, round(p_amount, 2);
  END IF;

  INSERT INTO plan_prepayments (account_id, plan_id, amount, mode, method, reference, note, changes)
  VALUES (v_plan.account_id, p_plan_id, round(p_amount, 2), p_mode,
          NULLIF(trim(p_method), ''), NULLIF(trim(p_reference), ''), NULLIF(trim(p_note), ''), v_audit)
  RETURNING id INTO v_id;

  -- Si ya no queda nada pendiente, el plan queda pagado.
  IF NOT EXISTS (SELECT 1 FROM installments WHERE plan_id = p_plan_id AND status = 'pendiente') THEN
    UPDATE payment_plans SET status = 'pagado', updated_at = now() WHERE id = p_plan_id;
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_prepayment(uuid, numeric, text, jsonb, text, text, text) TO authenticated;

-- ------------------------------------------------------------
-- 5. Saldos con abonos (mismas columnas y orden que 043 + prepaid_amount)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.payment_plan_balances
WITH (security_invoker = true) AS
SELECT
  p.id                AS plan_id,
  p.account_id,
  p.contact_id,
  p.currency,
  p.total_amount,
  p.down_payment,
  p.installments_count,
  p.monthly_amount,
  p.status,
  -- Cuotas pagadas (paid_amount o, si no se escribió, lo que valían) más
  -- los abonos a capital.
  COALESCE(i.paid, 0) + COALESCE(pp.prepaid, 0)  AS paid_amount,
  COALESCE(i.paid_count, 0)                      AS paid_count,
  COALESCE(i.pending_amount, 0)                  AS pending_amount,
  COALESCE(i.pending_count, 0)                   AS pending_count,
  COALESCE(i.overdue_count, 0)                   AS overdue_count,
  COALESCE(i.overdue_amount, 0)                  AS overdue_amount,
  i.next_due_date,
  COALESCE(pp.prepaid, 0)                        AS prepaid_amount
FROM payment_plans p
LEFT JOIN LATERAL (
  SELECT
    SUM(COALESCE(x.paid_amount, x.amount)) FILTER (WHERE x.status = 'pagada')            AS paid,
    COUNT(*) FILTER (WHERE x.status = 'pagada')                                          AS paid_count,
    SUM(x.amount) FILTER (WHERE x.status = 'pendiente')                                  AS pending_amount,
    COUNT(*) FILTER (WHERE x.status = 'pendiente')                                       AS pending_count,
    COUNT(*) FILTER (WHERE x.status = 'pendiente' AND x.due_date < current_date)         AS overdue_count,
    SUM(x.amount) FILTER (WHERE x.status = 'pendiente' AND x.due_date < current_date)    AS overdue_amount,
    MIN(x.due_date) FILTER (WHERE x.status = 'pendiente')                                AS next_due_date
  FROM installments x WHERE x.plan_id = p.id
) i ON true
LEFT JOIN LATERAL (
  SELECT SUM(y.amount) AS prepaid FROM plan_prepayments y WHERE y.plan_id = p.id
) pp ON true;

NOTIFY pgrst, 'reload schema';
