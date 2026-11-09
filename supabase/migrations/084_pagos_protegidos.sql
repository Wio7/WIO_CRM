-- ============================================================
-- 084_pagos_protegidos.sql — Libro de pagos, acceso por módulo y reglas
--                            de cobranza (Wio Suite, fase A)
--
-- Diseño: docs/superpowers/specs/2026-11-07-fase-a-pagos-y-reglas-design.md
-- Casos:  supabase/tests/084_casos.sql (correr DESPUÉS de aplicar esta).
--
-- Qué cambia:
--   1. Áreas: suma 'gerencia' y 'contabilidad'; el área solo cambia con
--      set_member_area (el guard de 067 ahora también la vigila).
--   2. Configuración de cobranza por cuenta (mora diaria con tope, partes
--      por cuota, umbrales de causal) y términos copiados a cada plan.
--   3. Acceso por módulo: can_access_module / my_module_access. Acceso
--      total = dueño de la cuenta o super admin. Ser admin ya NO abre
--      todos los módulos.
--   4. Libro de pagos installment_payments (una fila por pago o parte;
--      no se borra, se anula) + copia histórica legacy de cuotas pagadas.
--   5. Vistas installment_balances y payment_plan_balances (desde el libro).
--   6. Trigger que impide a un usuario (authenticated/anon) tocar montos,
--      fechas y estados de cuotas y planes: solo los RPC de aquí (dueño
--      postgres) y el service role.
--   7. RLS: cronograma (planes + vista installment_schedule, sin pagos)
--      para cobranzas, contabilidad, gerencia y legal; cobranza (tabla
--      installments, pagos, saldos, gestiones, avisos, abonos) para
--      cobranzas, contabilidad y gerencia.
--   8. RPCs: register_installment_payment, register_advance_payment,
--      void_installment_payment, create_payment_plan, reject_client_voucher
--      y apply_prepayment (083) recreado.
--
-- Idempotente — se puede volver a correr.
-- ============================================================
BEGIN;

-- ============================================================
-- 1. Áreas
-- ============================================================
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_area_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_area_check
  CHECK (area IS NULL OR area IN ('marketing', 'legal', 'cobranzas', 'ventas', 'gerencia', 'contabilidad'));

-- set_member_area (057) con las áreas nuevas y dos reglas más:
--   · 'gerencia' abre abonos a capital, pagos atrasados y anulaciones:
--     solo la reparte el dueño.
--   · un administrador ya no se cambia su propia área (antes podía
--     ponerse 'cobranzas' y abrir el módulo a sí mismo).
CREATE OR REPLACE FUNCTION public.set_member_area(
  p_user_id UUID,
  p_area TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_account, v_caller_role
  FROM profiles WHERE user_id = auth.uid();

  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_area IS NOT NULL
     AND p_area NOT IN ('marketing', 'legal', 'cobranzas', 'ventas', 'gerencia', 'contabilidad') THEN
    RAISE EXCEPTION 'Unknown area: %', p_area USING ERRCODE = '22023';
  END IF;

  SELECT account_role INTO v_target_role
  FROM profiles
  WHERE user_id = p_user_id AND account_id = v_account;

  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '22023';
  END IF;

  IF v_caller_role = 'admin' AND v_target_role IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only an owner can change an admin''s area'
      USING ERRCODE = '42501';
  END IF;

  IF v_caller_role <> 'owner' AND p_area = 'gerencia' THEN
    RAISE EXCEPTION 'Only an owner can grant the gerencia area'
      USING ERRCODE = '42501';
  END IF;

  IF v_caller_role <> 'owner'
     AND (SELECT area FROM profiles WHERE user_id = p_user_id AND account_id = v_account) = 'gerencia' THEN
    RAISE EXCEPTION 'Only an owner can change a gerencia member''s area'
      USING ERRCODE = '42501';
  END IF;

  UPDATE profiles
     SET area = p_area,
         area_set_by = (SELECT id FROM profiles WHERE user_id = auth.uid()),
         area_set_at = NOW()
   WHERE user_id = p_user_id AND account_id = v_account;
END;
$$;

ALTER FUNCTION public.set_member_area(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_area(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_area(UUID, TEXT) TO authenticated;

-- Guard de 067 ampliado: el área (y quién/cuándo la puso) tampoco se
-- cambia por la policy profiles_update ("editar mi perfil").
CREATE OR REPLACE FUNCTION public.guard_profile_account_membership()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'La pertenencia se crea mediante una función autorizada' USING ERRCODE = '42501';
    ELSIF NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.account_role IS DISTINCT FROM OLD.account_role
       OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'La pertenencia se cambia mediante una función autorizada' USING ERRCODE = '42501';
    ELSIF NEW.area IS DISTINCT FROM OLD.area
       OR NEW.area_set_by IS DISTINCT FROM OLD.area_set_by
       OR NEW.area_set_at IS DISTINCT FROM OLD.area_set_at THEN
      RAISE EXCEPTION 'El área se cambia con set_member_area' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_profile_account_membership ON public.profiles;
CREATE TRIGGER guard_profile_account_membership BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_account_membership();

-- ============================================================
-- 2. Configuración de cobranza por cuenta y términos por plan
-- ============================================================
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS late_fee_cap_days       integer NOT NULL DEFAULT 0,
  -- Aviso, no tope duro: owner/gerencia pueden seguir partiendo la cuota.
  ADD COLUMN IF NOT EXISTS max_payment_parts       integer NOT NULL DEFAULT 1,
  -- Causal de resolución (badge calculado). 0 = sin badge.
  ADD COLUMN IF NOT EXISTS resolution_installments integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS resolution_days         integer NOT NULL DEFAULT 0;

-- 083 + 'diaria' (S/ por día, desde el día siguiente a la gracia, con tope
-- de días cobrados late_fee_cap_days; 0 = sin tope).
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_late_fee_valid;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_late_fee_valid CHECK (
  late_fee_type IN ('ninguna', 'fija', 'porcentaje_mensual', 'diaria')
  AND late_fee_value >= 0
  AND (late_fee_type <> 'porcentaje_mensual' OR late_fee_value <= 100)
  AND late_fee_grace_days BETWEEN 0 AND 365
  AND late_fee_cap_days BETWEEN 0 AND 3650
);

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_collection_rules_valid;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_collection_rules_valid CHECK (
  max_payment_parts BETWEEN 1 AND 12
  AND resolution_installments BETWEEN 0 AND 120
  AND resolution_days BETWEEN 0 AND 3650
);

-- Términos que regían al firmar: create_payment_plan los copia de la
-- cuenta. Los cálculos leen el plan y, si falta, la cuenta. Los planes
-- anteriores a 084 quedan en NULL a propósito (siguen la cuenta).
ALTER TABLE public.payment_plans
  ADD COLUMN IF NOT EXISTS collection_terms jsonb;

-- Voucher del cliente: el monto que declara (puede ser una parte) y el
-- último rechazo {path, declared_amount, method, reference, reason, by, at}.
ALTER TABLE public.installments
  ADD COLUMN IF NOT EXISTS declared_amount   numeric(12,2),
  ADD COLUMN IF NOT EXISTS voucher_rejection jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'installments_declared_amount_positive') THEN
    ALTER TABLE public.installments
      ADD CONSTRAINT installments_declared_amount_positive CHECK (declared_amount IS NULL OR declared_amount > 0);
  END IF;
END $$;

-- Gestiones: "Ultimátum enviado" y "Pase a legal" (con la fecha de la fila).
ALTER TABLE public.collection_actions DROP CONSTRAINT IF EXISTS collection_actions_result_check;
ALTER TABLE public.collection_actions ADD CONSTRAINT collection_actions_result_check
  CHECK (result IN ('contactado', 'no_contesta', 'promesa', 'pago', 'rehusa', 'numero_errado',
                    'ultimatum', 'pase_legal'));

-- ============================================================
-- 3. Acceso por módulo
-- ============================================================
CREATE TABLE IF NOT EXISTS public.account_module_members (
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  module_key  text NOT NULL CHECK (module_key IN ('cobranzas', 'legal', 'cronograma', 'ventas')),
  granted_by  uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id, module_key)
);

CREATE INDEX IF NOT EXISTS idx_account_module_members_user
  ON public.account_module_members(user_id);

ALTER TABLE public.account_module_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_module_members FROM anon;

-- Acceso total: dueño de la cuenta o super admin (que, de visita, entra
-- como owner; en su casa también). Siempre dentro de una cuenta suya.
CREATE OR REPLACE FUNCTION public.has_full_access(p_account_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND p_account_id IS NOT NULL AND (
    public.is_account_member(p_account_id, 'owner')
    OR (public.is_super_admin() AND EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.user_id = auth.uid() AND p.account_id = p_account_id))
  );
$$;
ALTER FUNCTION public.has_full_access(uuid) OWNER TO postgres;

-- Módulos y sus áreas:
--   cobranzas   cobranzas, contabilidad, gerencia      (pagos, gestiones, avisos, abonos)
--   cronograma  cobranzas, contabilidad, gerencia, legal  (planes y cuotas, sin pagos)
--   legal       legal
--   ventas      ventas, o sin área (060: un asesor sin área es de ventas)
-- Permiso explícito: account_module_members (cobranzas o legal dan
-- también cronograma). Mínimo rol 'agent', como las policies de 043.
CREATE OR REPLACE FUNCTION public.can_access_module(p_account_id uuid, p_module text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL OR p_account_id IS NULL THEN false
    WHEN public.has_full_access(p_account_id) THEN true
    WHEN NOT public.is_account_member(p_account_id, 'agent') THEN false
    ELSE EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.user_id = auth.uid()
         AND p.account_id = p_account_id
         AND CASE p_module
               WHEN 'cobranzas'  THEN p.area IN ('cobranzas', 'contabilidad', 'gerencia')
               WHEN 'cronograma' THEN p.area IN ('cobranzas', 'contabilidad', 'gerencia', 'legal')
               WHEN 'legal'      THEN p.area = 'legal'
               WHEN 'ventas'     THEN p.area IS NULL OR p.area = 'ventas'
               ELSE false
             END
    ) OR EXISTS (
      SELECT 1 FROM public.account_module_members m
       WHERE m.account_id = p_account_id
         AND m.user_id = auth.uid()
         AND (m.module_key = p_module
              OR (p_module = 'cronograma' AND m.module_key IN ('cobranzas', 'legal')))
    )
  END;
$$;
ALTER FUNCTION public.can_access_module(uuid, text) OWNER TO postgres;

-- Dueño, super admin o área gerencia: abonos a capital, pagos con fecha
-- vieja, partes por encima del máximo y anulaciones de otros.
CREATE OR REPLACE FUNCTION public.is_owner_or_gerencia(p_account_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.has_full_access(p_account_id)
      OR (public.is_account_member(p_account_id, 'agent') AND EXISTS (
            SELECT 1 FROM public.profiles p
             WHERE p.user_id = auth.uid()
               AND p.account_id = p_account_id
               AND p.area = 'gerencia'));
$$;
ALTER FUNCTION public.is_owner_or_gerencia(uuid) OWNER TO postgres;

-- Quién crea planes (y agrega cuotas pendientes): legal, cobranzas, dueño.
CREATE OR REPLACE FUNCTION public.can_manage_schedule(p_account_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.has_full_access(p_account_id)
      OR (public.is_account_member(p_account_id, 'agent') AND (
            EXISTS (SELECT 1 FROM public.profiles p
                     WHERE p.user_id = auth.uid()
                       AND p.account_id = p_account_id
                       AND p.area IN ('legal', 'cobranzas'))
         OR EXISTS (SELECT 1 FROM public.account_module_members m
                     WHERE m.account_id = p_account_id
                       AND m.user_id = auth.uid()
                       AND m.module_key IN ('legal', 'cobranzas'))));
$$;
ALTER FUNCTION public.can_manage_schedule(uuid) OWNER TO postgres;

-- Para el menú y las pantallas ("sin acceso" ≠ "no es cliente").
-- 'gerencia' va de más: la UI lo usa para ofrecer abonos y anulaciones.
CREATE OR REPLACE FUNCTION public.my_module_access()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT jsonb_build_object(
              'cobranzas',  public.can_access_module(p.account_id, 'cobranzas'),
              'legal',      public.can_access_module(p.account_id, 'legal'),
              'cronograma', public.can_access_module(p.account_id, 'cronograma'),
              'ventas',     public.can_access_module(p.account_id, 'ventas'),
              'gerencia',   public.is_owner_or_gerencia(p.account_id))
       FROM public.profiles p WHERE p.user_id = auth.uid()),
    jsonb_build_object('cobranzas', false, 'legal', false, 'cronograma', false,
                       'ventas', false, 'gerencia', false));
$$;
ALTER FUNCTION public.my_module_access() OWNER TO postgres;

-- Las cuatro primeras corren dentro de policies: también para anon (que
-- obtiene false) para que una consulta anónima no falle con "permission
-- denied for function".
REVOKE ALL ON FUNCTION public.has_full_access(uuid)          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_access_module(uuid, text)  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_owner_or_gerencia(uuid)     FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_manage_schedule(uuid)      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.my_module_access()             FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_full_access(uuid)         TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_module(uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_owner_or_gerencia(uuid)    TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_schedule(uuid)     TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.my_module_access()            TO authenticated;

-- Permisos explícitos: los ve el interesado y quien tiene acceso total;
-- solo el acceso total los da o los quita, y solo a miembros de la cuenta.
DROP POLICY IF EXISTS account_module_members_select ON public.account_module_members;
CREATE POLICY account_module_members_select ON public.account_module_members FOR SELECT
  USING (user_id = auth.uid() OR public.has_full_access(account_id));
DROP POLICY IF EXISTS account_module_members_insert ON public.account_module_members;
CREATE POLICY account_module_members_insert ON public.account_module_members FOR INSERT
  WITH CHECK (
    public.has_full_access(account_id)
    AND EXISTS (SELECT 1 FROM public.profiles p
                 WHERE p.user_id = account_module_members.user_id
                   AND p.account_id = account_module_members.account_id)
  );
DROP POLICY IF EXISTS account_module_members_delete ON public.account_module_members;
CREATE POLICY account_module_members_delete ON public.account_module_members FOR DELETE
  USING (public.has_full_access(account_id));

-- ============================================================
-- 4. Libro de pagos
-- ============================================================
CREATE TABLE IF NOT EXISTS public.installment_payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Las FKs se fijan más abajo (bloque DO), también si la tabla ya existía.
  account_id          uuid NOT NULL,
  plan_id             uuid NOT NULL,
  installment_id      uuid NOT NULL,
  amount              numeric(12,2) NOT NULL CHECK (amount > 0),
  method              text,
  reference           text,
  -- Ruta en el bucket privado client-docs (042), como installments.voucher_path.
  voucher_path        text,
  paid_on             date NOT NULL,
  -- Mora de referencia al momento del pago (nunca se suma a la deuda).
  -- Solo se calcula para mora 'diaria'; con otros tipos queda NULL.
  late_fee_at_payment numeric(12,2),
  registered_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Copia histórica de una cuota 'pagada' antes de 084: puede no cuadrar
  -- con el monto de la cuota (paid_amount se escribía a mano).
  legacy              boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  voided_at           timestamptz,
  voided_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  void_reason         text,
  CONSTRAINT installment_payments_void_has_reason CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);

-- Borrados:
--   · cuenta: CASCADE (el super admin borra cuentas enteras, con su libro);
--   · plan o cuota con pagos en una cuenta viva: NO ACTION = se rechaza.
--     NO ACTION (no RESTRICT) porque se revisa al final de la sentencia:
--     al borrar la cuenta, el libro ya se fue por su propia cascada.
-- Se recrean siempre: idempotente y corrige una 084 aplicada antes.
DO $$
BEGIN
  ALTER TABLE public.installment_payments DROP CONSTRAINT IF EXISTS installment_payments_account_id_fkey;
  ALTER TABLE public.installment_payments DROP CONSTRAINT IF EXISTS installment_payments_plan_id_fkey;
  ALTER TABLE public.installment_payments DROP CONSTRAINT IF EXISTS installment_payments_installment_id_fkey;
  ALTER TABLE public.installment_payments
    ADD CONSTRAINT installment_payments_account_id_fkey
      FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE,
    ADD CONSTRAINT installment_payments_plan_id_fkey
      FOREIGN KEY (plan_id) REFERENCES public.payment_plans(id) ON DELETE NO ACTION,
    ADD CONSTRAINT installment_payments_installment_id_fkey
      FOREIGN KEY (installment_id) REFERENCES public.installments(id) ON DELETE NO ACTION;
END $$;

CREATE INDEX IF NOT EXISTS idx_installment_payments_installment
  ON public.installment_payments(installment_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_installment_payments_plan
  ON public.installment_payments(plan_id);
-- Reporte diario de pagos.
CREATE INDEX IF NOT EXISTS idx_installment_payments_account_day
  ON public.installment_payments(account_id, paid_on DESC);
-- Una sola copia histórica por cuota.
CREATE UNIQUE INDEX IF NOT EXISTS installment_payments_one_legacy
  ON public.installment_payments(installment_id) WHERE legacy;

ALTER TABLE public.installment_payments ENABLE ROW LEVEL SECURITY;
-- Solo lectura para usuarios; escriben los RPC (dueño postgres).
REVOKE ALL ON public.installment_payments FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.installment_payments FROM authenticated;
GRANT SELECT ON public.installment_payments TO authenticated;

DROP POLICY IF EXISTS installment_payments_select ON public.installment_payments;
CREATE POLICY installment_payments_select ON public.installment_payments FOR SELECT
  USING (public.can_access_module(account_id, 'cobranzas'));

-- Un pago no se borra ni se reescribe (ni siquiera con service role).
-- Solo se permite:
--   · anularlo una vez (voided_at, voided_by, void_reason);
--   · que registered_by / voided_by pasen a NULL (ON DELETE SET NULL al
--     borrar el usuario de Auth);
--   · borrarlo cuando se está borrando su cuenta entera (cascada).
CREATE OR REPLACE FUNCTION public.guard_installment_payment_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = OLD.account_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Un pago no se borra: se anula con void_installment_payment' USING ERRCODE = '42501';
  END IF;

  -- Usuario de Auth borrado: sus referencias quedan en NULL.
  IF (NEW.registered_by IS NULL OR NEW.registered_by IS NOT DISTINCT FROM OLD.registered_by)
     AND (NEW.voided_by IS NULL OR NEW.voided_by IS NOT DISTINCT FROM OLD.voided_by)
     AND (to_jsonb(NEW) - 'registered_by' - 'voided_by') = (to_jsonb(OLD) - 'registered_by' - 'voided_by') THEN
    RETURN NEW;
  END IF;

  -- Anulación: una vez, y nada más cambia.
  IF OLD.voided_at IS NULL
     AND NEW.voided_at IS NOT NULL
     AND (to_jsonb(NEW) - 'voided_at' - 'voided_by' - 'void_reason')
         = (to_jsonb(OLD) - 'voided_at' - 'voided_by' - 'void_reason') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Un pago registrado no se modifica; solo se anula una vez' USING ERRCODE = '42501';
END;
$$;
ALTER FUNCTION public.guard_installment_payment_immutable() OWNER TO postgres;
DROP TRIGGER IF EXISTS installment_payments_immutable ON public.installment_payments;
CREATE TRIGGER installment_payments_immutable
  BEFORE UPDATE OR DELETE ON public.installment_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_installment_payment_immutable();

-- Abonos a capital (083): también son dinero recibido. Mismo criterio que
-- el libro de pagos: la cuenta entera los borra en cascada; un plan con
-- abonos en una cuenta viva no se borra (NO ACTION), y un abono no se
-- borra ni se reescribe ni con service role; solo created_by pasa a NULL
-- al borrar el usuario de Auth. No hay "deshacer abono" todavía.
DO $$
BEGIN
  ALTER TABLE public.plan_prepayments DROP CONSTRAINT IF EXISTS plan_prepayments_plan_id_fkey;
  ALTER TABLE public.plan_prepayments
    ADD CONSTRAINT plan_prepayments_plan_id_fkey
      FOREIGN KEY (plan_id) REFERENCES public.payment_plans(id) ON DELETE NO ACTION;
END $$;

-- Solo lectura para usuarios (escribe apply_prepayment, dueño postgres).
REVOKE ALL ON public.plan_prepayments FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.plan_prepayments FROM authenticated;

DROP TRIGGER IF EXISTS plan_prepayments_no_delete ON public.plan_prepayments;
DROP FUNCTION IF EXISTS public.guard_plan_prepayment_delete();
CREATE OR REPLACE FUNCTION public.guard_plan_prepayment_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = OLD.account_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Un abono a capital no se borra' USING ERRCODE = '42501';
  END IF;
  IF NEW.created_by IS NULL
     AND (to_jsonb(NEW) - 'created_by') = (to_jsonb(OLD) - 'created_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Un abono a capital no se modifica' USING ERRCODE = '42501';
END;
$$;
ALTER FUNCTION public.guard_plan_prepayment_immutable() OWNER TO postgres;
DROP TRIGGER IF EXISTS plan_prepayments_immutable ON public.plan_prepayments;
CREATE TRIGGER plan_prepayments_immutable
  BEFORE UPDATE OR DELETE ON public.plan_prepayments
  FOR EACH ROW EXECUTE FUNCTION public.guard_plan_prepayment_immutable();

-- TRUNCATE salta RLS y los triggers por fila: se bloquea en los dos libros.
CREATE OR REPLACE FUNCTION public.guard_ledger_truncate()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'El libro % no se vacía', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;
ALTER FUNCTION public.guard_ledger_truncate() OWNER TO postgres;
DROP TRIGGER IF EXISTS plan_prepayments_no_truncate ON public.plan_prepayments;
CREATE TRIGGER plan_prepayments_no_truncate
  BEFORE TRUNCATE ON public.plan_prepayments
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ledger_truncate();
DROP TRIGGER IF EXISTS installment_payments_no_truncate ON public.installment_payments;
CREATE TRIGGER installment_payments_no_truncate
  BEFORE TRUNCATE ON public.installment_payments
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ledger_truncate();

-- Copia histórica: una fila legacy por cuota 'pagada' (adelantada y
-- condonada no se copian). Idempotente: no toca cuotas que ya tienen
-- alguna fila en el libro. registered_by de 047 es profiles.id; aquí va
-- el auth user de ese perfil.
INSERT INTO public.installment_payments
  (account_id, plan_id, installment_id, amount, method, reference, voucher_path,
   paid_on, registered_by, legacy, created_at)
SELECT i.account_id, i.plan_id, i.id,
       COALESCE(i.paid_amount, i.amount),
       i.paid_method, i.paid_reference, i.voucher_path,
       COALESCE((i.paid_at AT TIME ZONE 'America/Lima')::date, i.due_date),
       pr.user_id, true, COALESCE(i.paid_at, now())
  FROM public.installments i
  LEFT JOIN public.profiles pr ON pr.id = i.registered_by
 WHERE i.status = 'pagada'
   AND COALESCE(i.paid_amount, i.amount) > 0
   AND NOT EXISTS (SELECT 1 FROM public.installment_payments ip WHERE ip.installment_id = i.id);

-- ============================================================
-- 5. Saldos desde el libro
-- ============================================================
-- Por cuota. remaining = lo que falta de una cuota pendiente; una cuota
-- pagada, condonada o adelantada no debe nada (aunque una copia legacy no
-- cuadre con su monto). parts = pagos activos (no anulados).
CREATE OR REPLACE VIEW public.installment_balances
WITH (security_invoker = true) AS
SELECT
  i.id                                     AS installment_id,
  i.plan_id,
  i.account_id,
  i.amount,
  COALESCE(s.paid, 0)::numeric             AS paid_so_far,
  (CASE WHEN i.status = 'pendiente'
        THEN GREATEST(i.amount - COALESCE(s.paid, 0), 0)
        ELSE 0 END)::numeric               AS remaining,
  COALESCE(s.parts, 0)::integer            AS parts
FROM public.installments i
LEFT JOIN LATERAL (
  SELECT SUM(ip.amount) AS paid, COUNT(*) AS parts
    FROM public.installment_payments ip
   WHERE ip.installment_id = i.id AND ip.voided_at IS NULL
) s ON true;

REVOKE ALL ON public.installment_balances FROM anon;
GRANT SELECT ON public.installment_balances TO authenticated;

-- Por plan: mismas columnas, orden y tipos que 083 (CREATE OR REPLACE VIEW
-- solo permite agregar al final) + adelantada_count.
--   paid_amount     pagos activos del libro (partes incluidas) + abonos
--   pending_amount  lo que falta de las cuotas pendientes (remaining)
--   overdue_*       pendientes con saldo, vencidas según el día de Lima
-- Con security_invoker: quien no ve el libro (p. ej. legal) ve
-- paid_amount sin pagos y pending_amount = montos completos.
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
  (COALESCE(led.paid, 0) + COALESCE(pp.prepaid, 0))::numeric AS paid_amount,
  COALESCE(i.paid_count, 0)::bigint                          AS paid_count,
  COALESCE(i.pending_amount, 0)::numeric                     AS pending_amount,
  COALESCE(i.pending_count, 0)::bigint                       AS pending_count,
  COALESCE(i.overdue_count, 0)::bigint                       AS overdue_count,
  COALESCE(i.overdue_amount, 0)::numeric                     AS overdue_amount,
  i.next_due_date,
  COALESCE(pp.prepaid, 0)::numeric                           AS prepaid_amount,
  COALESCE(i.adelantada_count, 0)::bigint                    AS adelantada_count
FROM public.payment_plans p
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE x.status = 'pagada')                                    AS paid_count,
    SUM(b.rem) FILTER (WHERE x.status = 'pendiente')                               AS pending_amount,
    COUNT(*) FILTER (WHERE x.status = 'pendiente')                                 AS pending_count,
    COUNT(*) FILTER (WHERE x.status = 'pendiente' AND b.rem > 0
                       AND x.due_date < (now() AT TIME ZONE 'America/Lima')::date) AS overdue_count,
    SUM(b.rem) FILTER (WHERE x.status = 'pendiente'
                         AND x.due_date < (now() AT TIME ZONE 'America/Lima')::date) AS overdue_amount,
    MIN(x.due_date) FILTER (WHERE x.status = 'pendiente')                          AS next_due_date,
    COUNT(*) FILTER (WHERE x.status = 'adelantada')                                AS adelantada_count
  FROM public.installments x
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(ip.amount), 0) AS paid
      FROM public.installment_payments ip
     WHERE ip.installment_id = x.id AND ip.voided_at IS NULL
  ) s ON true
  CROSS JOIN LATERAL (
    SELECT CASE WHEN x.status = 'pendiente' THEN GREATEST(x.amount - s.paid, 0) ELSE 0 END AS rem
  ) b
  WHERE x.plan_id = p.id
) i ON true
LEFT JOIN LATERAL (
  SELECT SUM(ip.amount) AS paid
    FROM public.installment_payments ip
   WHERE ip.plan_id = p.id AND ip.voided_at IS NULL
) led ON true
LEFT JOIN LATERAL (
  SELECT SUM(y.amount) AS prepaid FROM public.plan_prepayments y WHERE y.plan_id = p.id
) pp ON true
-- Saldos = datos de cobranza: legal (que sí lee payment_plans) no los ve.
-- El servidor (service_role / postgres) sigue leyendo todo.
WHERE current_user NOT IN ('authenticated', 'anon')
   OR public.can_access_module(p.account_id, 'cobranzas');

-- Cronograma sin pagos, para quien entra a cronograma (legal incluido):
-- número, monto, fecha y un estado grueso. Vista de dueño (postgres,
-- security_invoker = false) porque la tabla installments ahora solo la
-- leen cobranzas, contabilidad, gerencia y el dueño; el filtro va adentro.
CREATE OR REPLACE VIEW public.installment_schedule
WITH (security_invoker = false) AS
SELECT
  i.id,
  i.plan_id,
  i.account_id,
  i.number,
  i.amount,
  i.due_date,
  (CASE WHEN i.status = 'pendiente' THEN 'pendiente' ELSE 'cerrada' END)::text AS state
FROM public.installments i
WHERE public.can_access_module(i.account_id, 'cronograma');

ALTER VIEW public.installment_schedule OWNER TO postgres;
REVOKE ALL ON public.installment_schedule FROM PUBLIC, anon;
GRANT SELECT ON public.installment_schedule TO authenticated, service_role;

-- ============================================================
-- 6. Montos, fechas y estados solo por función autorizada
--
-- Patrón de 067: los RPC SECURITY DEFINER corren como postgres y el
-- service role como service_role; solo un usuario (PostgREST hace SET
-- ROLE authenticated/anon) queda frenado.
-- ============================================================
CREATE OR REPLACE FUNCTION public.guard_payment_money_columns()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'installments' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.status IS DISTINCT FROM 'pendiente'
         OR NEW.paid_amount IS NOT NULL
         OR NEW.paid_at IS NOT NULL
         OR NEW.payment_id IS NOT NULL
         OR NEW.registered_by IS NOT NULL
         OR NEW.declared_amount IS NOT NULL
         OR NEW.voucher_rejection IS NOT NULL THEN
        RAISE EXCEPTION 'Una cuota nueva nace pendiente y sin pago; los pagos se registran mediante una función autorizada'
          USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.paid_amount IS DISTINCT FROM OLD.paid_amount
       OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
       OR NEW.due_date IS DISTINCT FROM OLD.due_date
       OR NEW.registered_by IS DISTINCT FROM OLD.registered_by
       OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
       OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.number IS DISTINCT FROM OLD.number
       -- Lo declara el cliente (portal, service role) y lo resuelven los RPC.
       OR NEW.declared_amount IS DISTINCT FROM OLD.declared_amount
       OR NEW.voucher_rejection IS DISTINCT FROM OLD.voucher_rejection THEN
      RAISE EXCEPTION 'Montos, fechas y estado de una cuota se cambian mediante una función autorizada'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    IF TG_OP = 'INSERT' THEN
      IF NEW.status IS DISTINCT FROM 'activo' THEN
        RAISE EXCEPTION 'Un plan nuevo nace activo; su estado lo cambia una función autorizada'
          USING ERRCODE = '42501';
      END IF;
      -- Los términos los copia create_payment_plan desde la cuenta.
      IF NEW.collection_terms IS NOT NULL THEN
        RAISE EXCEPTION 'Los términos de cobranza del plan los fija una función autorizada'
          USING ERRCODE = '42501';
      END IF;
    ELSIF NEW.total_amount IS DISTINCT FROM OLD.total_amount
       OR NEW.down_payment IS DISTINCT FROM OLD.down_payment
       OR NEW.monthly_amount IS DISTINCT FROM OLD.monthly_amount
       OR NEW.installments_count IS DISTINCT FROM OLD.installments_count
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.collection_terms IS DISTINCT FROM OLD.collection_terms THEN
      RAISE EXCEPTION 'Montos, moneda, estado y términos de un plan se cambian mediante una función autorizada'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS installments_guard_money ON public.installments;
CREATE TRIGGER installments_guard_money
  BEFORE INSERT OR UPDATE ON public.installments
  FOR EACH ROW EXECUTE FUNCTION public.guard_payment_money_columns();

DROP TRIGGER IF EXISTS payment_plans_guard_money ON public.payment_plans;
CREATE TRIGGER payment_plans_guard_money
  BEFORE INSERT OR UPDATE ON public.payment_plans
  FOR EACH ROW EXECUTE FUNCTION public.guard_payment_money_columns();

-- ============================================================
-- 7. RLS: cronograma vs cobranza
-- ============================================================
-- Cronograma: planes y cuotas (fechas y montos, sin pagos).
DROP POLICY IF EXISTS payment_plans_select ON public.payment_plans;
CREATE POLICY payment_plans_select ON public.payment_plans FOR SELECT
  USING (public.can_access_module(account_id, 'cronograma'));
DROP POLICY IF EXISTS payment_plans_insert ON public.payment_plans;
CREATE POLICY payment_plans_insert ON public.payment_plans FOR INSERT
  WITH CHECK (public.can_manage_schedule(account_id));
DROP POLICY IF EXISTS payment_plans_update ON public.payment_plans;
CREATE POLICY payment_plans_update ON public.payment_plans FOR UPDATE
  USING (public.can_access_module(account_id, 'cronograma'))
  WITH CHECK (public.can_access_module(account_id, 'cronograma'));
DROP POLICY IF EXISTS payment_plans_delete ON public.payment_plans;
CREATE POLICY payment_plans_delete ON public.payment_plans FOR DELETE
  USING (public.has_full_access(account_id));

-- La tabla installments tiene datos de pago (paid_*, voucher): solo el
-- grupo de cobranza. Legal lee el cronograma por installment_schedule.
DROP POLICY IF EXISTS installments_select ON public.installments;
CREATE POLICY installments_select ON public.installments FOR SELECT
  USING (public.can_access_module(account_id, 'cobranzas'));
DROP POLICY IF EXISTS installments_insert ON public.installments;
CREATE POLICY installments_insert ON public.installments FOR INSERT
  WITH CHECK (public.can_manage_schedule(account_id));
DROP POLICY IF EXISTS installments_update ON public.installments;
CREATE POLICY installments_update ON public.installments FOR UPDATE
  USING (public.can_access_module(account_id, 'cobranzas'))
  WITH CHECK (public.can_access_module(account_id, 'cobranzas'));
DROP POLICY IF EXISTS installments_delete ON public.installments;
CREATE POLICY installments_delete ON public.installments FOR DELETE
  USING (public.has_full_access(account_id));

-- Cobranza: abonos, avisos y gestiones.
DROP POLICY IF EXISTS plan_prepayments_select ON public.plan_prepayments;
CREATE POLICY plan_prepayments_select ON public.plan_prepayments FOR SELECT
  USING (public.can_access_module(account_id, 'cobranzas'));

DROP POLICY IF EXISTS installment_reminders_select ON public.installment_reminders;
CREATE POLICY installment_reminders_select ON public.installment_reminders FOR SELECT
  USING (public.can_access_module(account_id, 'cobranzas'));

-- 082 + módulo cobranzas.
DROP POLICY IF EXISTS collection_actions_select ON public.collection_actions;
CREATE POLICY collection_actions_select ON public.collection_actions FOR SELECT
  USING (
    public.can_access_module(account_id, 'cobranzas')
    AND public.is_account_member(account_id, 'agent')
    AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = collection_actions.contact_id)
  );

DROP POLICY IF EXISTS collection_actions_insert ON public.collection_actions;
CREATE POLICY collection_actions_insert ON public.collection_actions FOR INSERT
  WITH CHECK (
    public.can_access_module(account_id, 'cobranzas')
    AND public.is_account_member(account_id, 'agent')
    AND created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = collection_actions.contact_id
        AND c.account_id = collection_actions.account_id
    )
    AND (
      collection_actions.plan_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.payment_plans p
        WHERE p.id = collection_actions.plan_id
          AND p.account_id = collection_actions.account_id
      )
    )
  );

DROP POLICY IF EXISTS collection_actions_update ON public.collection_actions;
CREATE POLICY collection_actions_update ON public.collection_actions FOR UPDATE
  USING (
    public.can_access_module(account_id, 'cobranzas')
    AND (
      public.is_account_member(account_id, 'admin')
      OR (created_by = auth.uid() AND public.is_account_member(account_id, 'agent'))
    )
  )
  WITH CHECK (
    public.can_access_module(account_id, 'cobranzas')
    AND (
      public.is_account_member(account_id, 'admin')
      OR (created_by = auth.uid() AND public.is_account_member(account_id, 'agent'))
    )
    AND EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = collection_actions.contact_id
        AND c.account_id = collection_actions.account_id
    )
    AND (
      collection_actions.plan_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.payment_plans p
        WHERE p.id = collection_actions.plan_id
          AND p.account_id = collection_actions.account_id
      )
    )
  );

DROP POLICY IF EXISTS collection_actions_delete ON public.collection_actions;
CREATE POLICY collection_actions_delete ON public.collection_actions FOR DELETE
  USING (
    public.can_access_module(account_id, 'cobranzas')
    AND (
      public.is_account_member(account_id, 'admin')
      OR (created_by = auth.uid() AND public.is_account_member(account_id, 'agent'))
    )
  );

-- 067 + quien entra a Cobranzas ve los contactos que tienen un plan (si
-- no, un agente de cobranzas no vería los nombres de sus deudores).
DROP POLICY IF EXISTS contacts_select ON public.contacts;
CREATE POLICY contacts_select ON public.contacts FOR SELECT
  USING (
    public.is_account_member(account_id, 'admin')
    OR (public.is_account_member(account_id, 'viewer') AND (
      user_id = auth.uid() OR EXISTS (
        SELECT 1 FROM public.conversations c
        WHERE c.contact_id = contacts.id AND c.assigned_agent_id = auth.uid()
      )
    ))
    OR (public.can_access_module(account_id, 'cobranzas') AND EXISTS (
      SELECT 1 FROM public.payment_plans pp
      WHERE pp.contact_id = contacts.id AND pp.account_id = contacts.account_id
    ))
  );

-- ============================================================
-- 8. Ayudantes internos (solo los llaman los RPC de abajo)
-- ============================================================
CREATE OR REPLACE FUNCTION public.account_collection_terms(p_account_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public
AS $$
  SELECT jsonb_build_object(
           'late_fee_type',           a.late_fee_type,
           'late_fee_value',          a.late_fee_value,
           'late_fee_grace_days',     a.late_fee_grace_days,
           'late_fee_cap_days',       a.late_fee_cap_days,
           'max_payment_parts',       a.max_payment_parts,
           'resolution_installments', a.resolution_installments,
           'resolution_days',         a.resolution_days)
    FROM public.accounts a WHERE a.id = p_account_id;
$$;

-- Términos del plan; lo que falte, de la cuenta.
CREATE OR REPLACE FUNCTION public.plan_collection_terms(p_plan_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public
AS $$
  SELECT COALESCE(public.account_collection_terms(p.account_id), '{}'::jsonb)
         || CASE WHEN jsonb_typeof(p.collection_terms) = 'object' THEN p.collection_terms ELSE '{}'::jsonb END
    FROM public.payment_plans p WHERE p.id = p_plan_id;
$$;

-- Mora 'diaria' del contrato en este momento (misma regla que
-- contractLateFee de src/lib/late-fees.ts): valor × días desde la cuota
-- pendiente vencida más antigua, menos la gracia, con tope de días.
-- Diferencia a propósito: aquí no se excluyen cuotas con voucher en
-- revisión (al pagar, esa cuota sigue impaga hasta este momento).
-- Otros tipos: NULL (la app no los guarda al pagar).
CREATE OR REPLACE FUNCTION public.plan_late_fee(p_plan_id uuid)
RETURNS numeric
LANGUAGE plpgsql STABLE SET search_path = public
AS $$
DECLARE
  v_terms  jsonb := public.plan_collection_terms(p_plan_id);
  v_today  date := (now() AT TIME ZONE 'America/Lima')::date;
  v_value  numeric;
  v_grace  integer;
  v_cap    integer;
  v_oldest date;
  v_days   integer;
BEGIN
  IF v_terms IS NULL OR v_terms->>'late_fee_type' IS DISTINCT FROM 'diaria' THEN
    RETURN NULL;
  END IF;
  v_value := COALESCE(NULLIF(v_terms->>'late_fee_value', '')::numeric, 0);
  v_grace := GREATEST(COALESCE(NULLIF(v_terms->>'late_fee_grace_days', '')::integer, 0), 0);
  v_cap   := COALESCE(NULLIF(v_terms->>'late_fee_cap_days', '')::integer, 0);
  IF v_value <= 0 THEN
    RETURN 0;
  END IF;
  SELECT MIN(due_date) INTO v_oldest
    FROM public.installments
   WHERE plan_id = p_plan_id AND status = 'pendiente' AND due_date < v_today;
  IF v_oldest IS NULL THEN
    RETURN 0;
  END IF;
  v_days := (v_today - v_oldest) - v_grace;
  IF v_days <= 0 THEN
    RETURN 0;
  END IF;
  IF v_cap > 0 THEN
    v_days := LEAST(v_days, v_cap);
  END IF;
  RETURN round(v_value * v_days, 2);
END;
$$;

-- pagado ↔ activo según queden cuotas pendientes. No toca planes
-- suspendidos ni cancelados.
CREATE OR REPLACE FUNCTION public.sync_payment_plan_status(p_plan_id uuid)
RETURNS void
LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  UPDATE public.payment_plans p
     SET status = 'pagado', updated_at = now()
   WHERE p.id = p_plan_id AND p.status = 'activo'
     AND NOT EXISTS (SELECT 1 FROM public.installments i WHERE i.plan_id = p.id AND i.status = 'pendiente');
  UPDATE public.payment_plans p
     SET status = 'activo', updated_at = now()
   WHERE p.id = p_plan_id AND p.status = 'pagado'
     AND EXISTS (SELECT 1 FROM public.installments i WHERE i.plan_id = p.id AND i.status = 'pendiente');
END;
$$;

ALTER FUNCTION public.account_collection_terms(uuid) OWNER TO postgres;
ALTER FUNCTION public.plan_collection_terms(uuid) OWNER TO postgres;
ALTER FUNCTION public.plan_late_fee(uuid) OWNER TO postgres;
ALTER FUNCTION public.sync_payment_plan_status(uuid) OWNER TO postgres;
ALTER FUNCTION public.guard_payment_money_columns() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_collection_terms(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.plan_collection_terms(uuid)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.plan_late_fee(uuid)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_payment_plan_status(uuid) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 9. RPCs de pagos
--
-- Todos: SECURITY DEFINER (dueño postgres), bloquean el plan FOR UPDATE
-- y después sus cuotas (mismo orden que apply_prepayment: no se cruzan),
-- mismo mensaje si el plan/cuota no existe o es de otra cuenta, y
-- permiso del módulo cobranzas.
-- ============================================================

-- ------------------------------------------------------------
-- register_installment_payment — un pago o una parte de una cuota
--   · no supera lo que falta (remaining);
--   · si completa la cuota, la pasa a 'pagada';
--   · paid_on: hoy por defecto, nunca futura; más de 7 días atrás solo
--     dueño/gerencia;
--   · partes: con max_payment_parts del plan/cuenta, la parte número
--     max tiene que completar la cuota (dueño/gerencia pueden seguir);
--   · se lleva el voucher que subió el cliente (y su método/operación) y
--     lo limpia de la cuota, junto con declared_amount.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_installment_payment(
  p_installment_id uuid,
  p_amount         numeric,
  p_method         text DEFAULT NULL,
  p_reference      text DEFAULT NULL,
  p_voucher_path   text DEFAULT NULL,
  p_paid_on        date DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today     date := (now() AT TIME ZONE 'America/Lima')::date;
  v_plan_id   uuid;
  v_plan      payment_plans%ROWTYPE;
  v_inst      installments%ROWTYPE;
  v_amount    numeric(12,2);
  v_paid      numeric(12,2);
  v_parts     integer;
  v_remaining numeric(12,2);
  v_max       integer;
  v_manager   boolean;
  v_paid_on   date;
  v_voucher   text;
  v_method    text;
  v_reference text;
  v_id        uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501';
  END IF;
  v_amount := round(p_amount, 2);
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'El pago debe ser mayor a cero' USING ERRCODE = '22023';
  END IF;

  SELECT plan_id INTO v_plan_id FROM installments WHERE id = p_installment_id;
  SELECT * INTO v_plan FROM payment_plans WHERE id = v_plan_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_module(v_plan.account_id, 'cobranzas') THEN
    RAISE EXCEPTION 'Cuota no encontrada' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_inst FROM installments WHERE id = p_installment_id FOR UPDATE;

  IF v_plan.status <> 'activo' THEN
    RAISE EXCEPTION 'Solo se registran pagos en planes activos (este está %)', v_plan.status;
  END IF;
  IF v_inst.status <> 'pendiente' THEN
    RAISE EXCEPTION 'La cuota % ya no está pendiente (%)', v_inst.number, v_inst.status;
  END IF;

  v_manager := public.is_owner_or_gerencia(v_plan.account_id);
  v_paid_on := COALESCE(p_paid_on, v_today);
  IF v_paid_on > v_today THEN
    RAISE EXCEPTION 'La fecha de pago no puede ser futura';
  END IF;
  IF v_paid_on < v_today - 7 AND NOT v_manager THEN
    RAISE EXCEPTION 'Un pago de hace más de 7 días solo lo registra el dueño o gerencia';
  END IF;

  SELECT COALESCE(SUM(amount), 0), COUNT(*) INTO v_paid, v_parts
    FROM installment_payments
   WHERE installment_id = v_inst.id AND voided_at IS NULL;
  v_remaining := GREATEST(v_inst.amount - v_paid, 0);
  IF v_amount > v_remaining THEN
    RAISE EXCEPTION 'El pago (%) supera el saldo de la cuota % (%)', v_amount, v_inst.number, v_remaining;
  END IF;

  v_max := GREATEST(COALESCE(NULLIF(public.plan_collection_terms(v_plan.id)->>'max_payment_parts', '')::integer, 1), 1);
  IF NOT v_manager AND v_amount < v_remaining AND v_parts + 1 >= v_max THEN
    RAISE EXCEPTION 'La cuota % admite hasta % partes: este pago debe completarla (saldo %) o autorizarlo gerencia',
      v_inst.number, v_max, v_remaining;
  END IF;

  -- El voucher del cliente (si lo hay) pasa al pago con lo que declaró.
  v_voucher   := COALESCE(NULLIF(trim(p_voucher_path), ''), v_inst.voucher_path);
  v_method    := COALESCE(NULLIF(trim(p_method), ''),
                          CASE WHEN v_inst.voucher_path IS NOT NULL THEN v_inst.paid_method END);
  v_reference := COALESCE(NULLIF(trim(p_reference), ''),
                          CASE WHEN v_inst.voucher_path IS NOT NULL THEN v_inst.paid_reference END);

  INSERT INTO installment_payments
    (account_id, plan_id, installment_id, amount, method, reference, voucher_path,
     paid_on, late_fee_at_payment, registered_by)
  VALUES
    (v_plan.account_id, v_plan.id, v_inst.id, v_amount, left(v_method, 60), left(v_reference, 60), v_voucher,
     v_paid_on, public.plan_late_fee(v_plan.id), auth.uid())
  RETURNING id INTO v_id;

  IF v_amount = v_remaining THEN
    UPDATE installments
       SET status = 'pagada',
           paid_at = CASE WHEN v_paid_on = v_today THEN now()
                          ELSE (v_paid_on + time '12:00') AT TIME ZONE 'America/Lima' END,
           paid_amount = v_paid + v_amount,
           paid_method = left(v_method, 60),
           paid_reference = left(v_reference, 60),
           voucher_path = NULL,
           declared_amount = NULL,
           registered_by = (SELECT id FROM profiles WHERE user_id = auth.uid()),
           updated_at = now()
     WHERE id = v_inst.id;
  ELSE
    -- Sigue pendiente; el voucher y lo declarado ya viven en el pago.
    UPDATE installments
       SET voucher_path = NULL,
           declared_amount = NULL,
           paid_method = CASE WHEN voucher_path IS NOT NULL THEN NULL ELSE paid_method END,
           paid_reference = CASE WHEN voucher_path IS NOT NULL THEN NULL ELSE paid_reference END,
           updated_at = now()
     WHERE id = v_inst.id;
  END IF;

  PERFORM public.sync_payment_plan_status(v_plan.id);
  RETURN v_id;
END;
$$;

-- ------------------------------------------------------------
-- register_advance_payment — varias cuotas completas en una transacción.
-- Tienen que ser las siguientes pendientes en orden o las últimas (por
-- número). Cada una se paga por lo que le falta y pasa a 'pagada'.
-- Devuelve cuántas cuotas pagó.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_advance_payment(
  p_plan_id         uuid,
  p_installment_ids uuid[],
  p_method          text DEFAULT NULL,
  p_reference       text DEFAULT NULL,
  p_voucher_path    text DEFAULT NULL,
  p_paid_on         date DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today     date := (now() AT TIME ZONE 'America/Lima')::date;
  v_plan      payment_plans%ROWTYPE;
  v_pending   uuid[];
  v_k         integer;
  v_n         integer;
  v_paid_on   date;
  v_fee       numeric;
  v_inst      installments%ROWTYPE;
  v_paid      numeric(12,2);
  v_remaining numeric(12,2);
  v_voucher   text;
  v_method    text;
  v_reference text;
  v_profile   uuid;
  v_count     integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501';
  END IF;
  v_k := COALESCE(cardinality(p_installment_ids), 0);
  IF v_k = 0 THEN
    RAISE EXCEPTION 'Elige al menos una cuota';
  END IF;
  IF array_position(p_installment_ids, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT x) FROM unnest(p_installment_ids) x) <> v_k THEN
    RAISE EXCEPTION 'Cuotas repetidas o vacías';
  END IF;

  SELECT * INTO v_plan FROM payment_plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_module(v_plan.account_id, 'cobranzas') THEN
    RAISE EXCEPTION 'Plan no encontrado' USING ERRCODE = '42501';
  END IF;
  IF v_plan.status <> 'activo' THEN
    RAISE EXCEPTION 'Solo se registran pagos en planes activos (este está %)', v_plan.status;
  END IF;

  v_paid_on := COALESCE(p_paid_on, v_today);
  IF v_paid_on > v_today THEN
    RAISE EXCEPTION 'La fecha de pago no puede ser futura';
  END IF;
  IF v_paid_on < v_today - 7 AND NOT public.is_owner_or_gerencia(v_plan.account_id) THEN
    RAISE EXCEPTION 'Un pago de hace más de 7 días solo lo registra el dueño o gerencia';
  END IF;

  PERFORM 1 FROM installments WHERE plan_id = p_plan_id FOR UPDATE;
  SELECT array_agg(id ORDER BY number) INTO v_pending
    FROM installments WHERE plan_id = p_plan_id AND status = 'pendiente';
  v_n := COALESCE(cardinality(v_pending), 0);

  IF NOT (p_installment_ids <@ COALESCE(v_pending, '{}'::uuid[])) THEN
    RAISE EXCEPTION 'Una de las cuotas no es de este plan o ya no está pendiente';
  END IF;
  IF NOT (p_installment_ids <@ v_pending[1:v_k] OR p_installment_ids <@ v_pending[v_n - v_k + 1:v_n]) THEN
    RAISE EXCEPTION 'Los adelantos son las siguientes cuotas en orden o las últimas, sin saltos';
  END IF;

  v_fee := public.plan_late_fee(p_plan_id);
  v_profile := (SELECT id FROM profiles WHERE user_id = auth.uid());

  FOR v_inst IN
    SELECT * FROM installments WHERE id = ANY(p_installment_ids) ORDER BY number
  LOOP
    SELECT COALESCE(SUM(amount), 0) INTO v_paid
      FROM installment_payments
     WHERE installment_id = v_inst.id AND voided_at IS NULL;
    v_remaining := GREATEST(v_inst.amount - v_paid, 0);
    IF v_remaining <= 0 THEN
      RAISE EXCEPTION 'La cuota % no tiene saldo', v_inst.number;
    END IF;

    v_voucher   := COALESCE(NULLIF(trim(p_voucher_path), ''), v_inst.voucher_path);
    v_method    := COALESCE(NULLIF(trim(p_method), ''),
                            CASE WHEN v_inst.voucher_path IS NOT NULL THEN v_inst.paid_method END);
    v_reference := COALESCE(NULLIF(trim(p_reference), ''),
                            CASE WHEN v_inst.voucher_path IS NOT NULL THEN v_inst.paid_reference END);

    INSERT INTO installment_payments
      (account_id, plan_id, installment_id, amount, method, reference, voucher_path,
       paid_on, late_fee_at_payment, registered_by)
    VALUES
      (v_plan.account_id, v_plan.id, v_inst.id, v_remaining, left(v_method, 60), left(v_reference, 60), v_voucher,
       v_paid_on, v_fee, auth.uid());

    UPDATE installments
       SET status = 'pagada',
           paid_at = CASE WHEN v_paid_on = v_today THEN now()
                          ELSE (v_paid_on + time '12:00') AT TIME ZONE 'America/Lima' END,
           paid_amount = v_paid + v_remaining,
           paid_method = left(v_method, 60),
           paid_reference = left(v_reference, 60),
           voucher_path = NULL,
           declared_amount = NULL,
           registered_by = v_profile,
           updated_at = now()
     WHERE id = v_inst.id;

    v_count := v_count + 1;
  END LOOP;

  PERFORM public.sync_payment_plan_status(v_plan.id);
  RETURN v_count;
END;
$$;

-- ------------------------------------------------------------
-- void_installment_payment — anular (nunca borrar) un pago, con motivo.
-- Lo anula el dueño/gerencia, o quien lo registró el mismo día (Lima) si
-- no es una copia legacy. Si la cuota queda incompleta vuelve a
-- 'pendiente'; un plan 'pagado' vuelve a 'activo' (suspendidos y
-- cancelados no se reabren).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_installment_payment(
  p_payment_id uuid,
  p_reason     text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today   date := (now() AT TIME ZONE 'America/Lima')::date;
  v_plan_id uuid;
  v_plan    payment_plans%ROWTYPE;
  v_pay     installment_payments%ROWTYPE;
  v_inst    installments%ROWTYPE;
  v_paid    numeric(12,2);
  v_reason  text := NULLIF(left(trim(p_reason), 500), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Indica el motivo de la anulación';
  END IF;

  SELECT plan_id INTO v_plan_id FROM installment_payments WHERE id = p_payment_id;
  SELECT * INTO v_plan FROM payment_plans WHERE id = v_plan_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_module(v_plan.account_id, 'cobranzas') THEN
    RAISE EXCEPTION 'Pago no encontrado' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_pay FROM installment_payments WHERE id = p_payment_id FOR UPDATE;
  IF v_pay.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'El pago ya está anulado';
  END IF;
  IF NOT public.is_owner_or_gerencia(v_plan.account_id)
     AND NOT (COALESCE(v_pay.registered_by = auth.uid(), false)
              AND NOT v_pay.legacy
              AND (v_pay.created_at AT TIME ZONE 'America/Lima')::date = v_today) THEN
    RAISE EXCEPTION 'Solo el dueño o gerencia anulan pagos de otro día o de otra persona' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inst FROM installments WHERE id = v_pay.installment_id FOR UPDATE;

  UPDATE installment_payments
     SET voided_at = now(), voided_by = auth.uid(), void_reason = v_reason
   WHERE id = v_pay.id;

  SELECT COALESCE(SUM(amount), 0) INTO v_paid
    FROM installment_payments
   WHERE installment_id = v_inst.id AND voided_at IS NULL;

  IF v_inst.status = 'pagada' AND v_paid < v_inst.amount THEN
    UPDATE installments
       SET status = 'pendiente',
           paid_at = NULL,
           paid_amount = NULL,
           paid_method = NULL,
           paid_reference = NULL,
           registered_by = NULL,
           updated_at = now()
     WHERE id = v_inst.id;
  END IF;

  PERFORM public.sync_payment_plan_status(v_plan.id);
END;
$$;

-- ------------------------------------------------------------
-- reject_client_voucher — el voucher del cliente no vale: se limpia de
-- la cuota y queda el rechazo (ruta, monto declarado, motivo, quién,
-- cuándo) en installments.voucher_rejection. El archivo queda en el
-- bucket; borrarlo es decisión de la app.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_client_voucher(
  p_installment_id uuid,
  p_reason         text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plan_id uuid;
  v_plan    payment_plans%ROWTYPE;
  v_inst    installments%ROWTYPE;
  v_reason  text := NULLIF(left(trim(p_reason), 500), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Indica el motivo del rechazo';
  END IF;

  SELECT plan_id INTO v_plan_id FROM installments WHERE id = p_installment_id;
  SELECT * INTO v_plan FROM payment_plans WHERE id = v_plan_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_module(v_plan.account_id, 'cobranzas') THEN
    RAISE EXCEPTION 'Cuota no encontrada' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_inst FROM installments WHERE id = p_installment_id FOR UPDATE;
  IF v_inst.status <> 'pendiente' OR v_inst.voucher_path IS NULL THEN
    RAISE EXCEPTION 'La cuota % no tiene un voucher en revisión', v_inst.number;
  END IF;

  UPDATE installments
     SET voucher_rejection = jsonb_build_object(
           'path', voucher_path,
           'declared_amount', declared_amount,
           'method', paid_method,
           'reference', paid_reference,
           'reason', v_reason,
           'by', auth.uid(),
           'at', now()),
         voucher_path = NULL,
         declared_amount = NULL,
         paid_method = NULL,
         paid_reference = NULL,
         updated_at = now()
   WHERE id = v_inst.id;
END;
$$;

-- ------------------------------------------------------------
-- create_payment_plan — lo crean legal, cobranzas y el dueño.
-- p: {contact_id, unit_id, reservation_id, currency, total_amount,
--     down_payment, installments_count, monthly_amount, due_day,
--     first_due_date, notes, installments: [{number, amount, due_date}]}
-- Las cuotas son 1..installments_count y suman total − inicial exacto.
-- Copia los términos de cobranza de la cuenta a collection_terms.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_payment_plan(p jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile_id  uuid;
  v_acc         uuid;
  v_contact     uuid;
  v_unit        uuid;
  v_reservation uuid;
  v_currency    text;
  v_total       numeric(12,2);
  v_down        numeric(12,2);
  v_count       integer;
  v_monthly     numeric(12,2);
  v_due_day     integer;
  v_first_due   date;
  v_rows        jsonb;
  v_n           integer;
  v_distinct    integer;
  v_min         integer;
  v_max         integer;
  v_sum         numeric;
  v_valid       boolean;
  v_id          uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501';
  END IF;
  SELECT id, account_id INTO v_profile_id, v_acc FROM profiles WHERE user_id = auth.uid();
  IF v_acc IS NULL OR NOT public.can_manage_schedule(v_acc) THEN
    RAISE EXCEPTION 'Solo legal, cobranzas o el dueño crean planes de pago' USING ERRCODE = '42501';
  END IF;
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'Datos del plan no válidos' USING ERRCODE = '22023';
  END IF;

  v_contact     := NULLIF(p->>'contact_id', '')::uuid;
  v_unit        := NULLIF(p->>'unit_id', '')::uuid;
  v_reservation := NULLIF(p->>'reservation_id', '')::uuid;
  v_currency    := upper(COALESCE(NULLIF(trim(p->>'currency'), ''), 'PEN'));
  v_total       := round(NULLIF(p->>'total_amount', '')::numeric, 2);
  v_down        := round(COALESCE(NULLIF(p->>'down_payment', '')::numeric, 0), 2);
  v_count       := NULLIF(p->>'installments_count', '')::integer;
  v_monthly     := round(NULLIF(p->>'monthly_amount', '')::numeric, 2);
  v_due_day     := NULLIF(p->>'due_day', '')::integer;
  v_first_due   := NULLIF(p->>'first_due_date', '')::date;
  v_rows        := p->'installments';

  IF v_contact IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM contacts WHERE id = v_contact AND account_id = v_acc) THEN
    RAISE EXCEPTION 'Cliente no encontrado' USING ERRCODE = '22023';
  END IF;
  IF v_unit IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM real_estate_units WHERE id = v_unit AND account_id = v_acc) THEN
    RAISE EXCEPTION 'Lote no encontrado' USING ERRCODE = '22023';
  END IF;
  IF v_reservation IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM reservations WHERE id = v_reservation AND account_id = v_acc) THEN
    RAISE EXCEPTION 'Separación no encontrada' USING ERRCODE = '22023';
  END IF;
  IF v_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Moneda no válida: %', v_currency USING ERRCODE = '22023';
  END IF;
  IF v_total IS NULL OR v_total <= 0 THEN
    RAISE EXCEPTION 'El precio tiene que ser mayor a cero' USING ERRCODE = '22023';
  END IF;
  IF v_down < 0 OR v_down >= v_total THEN
    RAISE EXCEPTION 'La inicial tiene que ser menor que el precio' USING ERRCODE = '22023';
  END IF;
  IF v_count IS NULL OR v_count <= 0 THEN
    RAISE EXCEPTION 'El número de cuotas tiene que ser mayor a cero' USING ERRCODE = '22023';
  END IF;
  IF v_monthly IS NULL OR v_monthly <= 0 THEN
    RAISE EXCEPTION 'La cuota mensual tiene que ser mayor a cero' USING ERRCODE = '22023';
  END IF;
  IF v_due_day IS NOT NULL AND v_due_day NOT BETWEEN 1 AND 31 THEN
    RAISE EXCEPTION 'Día de pago no válido' USING ERRCODE = '22023';
  END IF;
  IF v_first_due IS NULL THEN
    RAISE EXCEPTION 'Falta la fecha de la primera cuota' USING ERRCODE = '22023';
  END IF;
  IF v_rows IS NULL OR jsonb_typeof(v_rows) <> 'array' THEN
    RAISE EXCEPTION 'Faltan las cuotas del plan' USING ERRCODE = '22023';
  END IF;

  SELECT count(*), count(DISTINCT r.number), min(r.number), max(r.number),
         sum(round(r.amount, 2)),
         COALESCE(bool_and(r.number IS NOT NULL AND r.amount > 0 AND r.due_date IS NOT NULL), false)
    INTO v_n, v_distinct, v_min, v_max, v_sum, v_valid
    FROM jsonb_to_recordset(v_rows) AS r(number integer, amount numeric, due_date date);

  IF v_n <> v_count OR v_distinct <> v_count OR v_min <> 1 OR v_max <> v_count THEN
    RAISE EXCEPTION 'Las cuotas tienen que ir numeradas de 1 a %', v_count USING ERRCODE = '22023';
  END IF;
  IF NOT v_valid THEN
    RAISE EXCEPTION 'Cada cuota necesita monto mayor a cero y fecha' USING ERRCODE = '22023';
  END IF;
  IF v_sum <> v_total - v_down THEN
    RAISE EXCEPTION 'Las cuotas suman % y deberían sumar % (precio − inicial)', v_sum, v_total - v_down
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO payment_plans
    (account_id, contact_id, unit_id, reservation_id, currency, total_amount, down_payment,
     installments_count, monthly_amount, due_day, first_due_date, notes, status, created_by,
     collection_terms)
  VALUES
    (v_acc, v_contact, v_unit, v_reservation, v_currency, v_total, v_down,
     v_count, v_monthly, v_due_day, v_first_due, NULLIF(left(trim(p->>'notes'), 2000), ''), 'activo', v_profile_id,
     public.account_collection_terms(v_acc))
  RETURNING id INTO v_id;

  INSERT INTO installments (plan_id, account_id, number, amount, due_date)
  SELECT v_id, v_acc, r.number, round(r.amount, 2), r.due_date
    FROM jsonb_to_recordset(v_rows) AS r(number integer, amount numeric, due_date date);

  RETURN v_id;
END;
$$;

-- ------------------------------------------------------------
-- apply_prepayment (083) recreado. Cambios:
--   · solo dueño o gerencia (antes cualquier agente);
--   · rechaza cuotas con pagos parciales activos en el libro;
--   · el estado del plan lo decide sync_payment_plan_status.
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
SECURITY DEFINER
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
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sin sesión';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'El abono debe ser mayor a cero';
  END IF;
  IF p_mode NOT IN ('reducir_plazo', 'reducir_cuota') THEN
    RAISE EXCEPTION 'Modo de abono no válido';
  END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'array' OR jsonb_array_length(p_changes) = 0 THEN
    RAISE EXCEPTION 'El abono no cambia ninguna cuota';
  END IF;

  SELECT * INTO v_plan FROM payment_plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND OR NOT public.can_access_module(v_plan.account_id, 'cobranzas') THEN
    RAISE EXCEPTION 'Plan no encontrado';
  END IF;
  IF NOT public.is_owner_or_gerencia(v_plan.account_id) THEN
    RAISE EXCEPTION 'Solo el dueño o gerencia aplican abonos a capital' USING ERRCODE = '42501';
  END IF;
  IF v_plan.status <> 'activo' THEN
    RAISE EXCEPTION 'Solo se abona a planes activos';
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
    IF EXISTS (SELECT 1 FROM installment_payments
                WHERE installment_id = v_inst.id AND voided_at IS NULL) THEN
      RAISE EXCEPTION 'La cuota % tiene pagos parciales; complétala o anúlalos antes de abonar', v_inst.number;
    END IF;
    IF v_inst.due_date < v_today THEN
      RAISE EXCEPTION 'La cuota % ya venció; se paga, no se abona', v_inst.number;
    END IF;
    IF v_inst.voucher_path IS NOT NULL THEN
      RAISE EXCEPTION 'La cuota % tiene un voucher en revisión; apruébalo o recházalo primero', v_inst.number;
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

  INSERT INTO plan_prepayments (account_id, plan_id, amount, mode, method, reference, note, changes, created_by)
  VALUES (v_plan.account_id, p_plan_id, round(p_amount, 2), p_mode,
          NULLIF(trim(p_method), ''), NULLIF(trim(p_reference), ''), NULLIF(left(trim(p_note), 1000), ''), v_audit,
          auth.uid())
  RETURNING id INTO v_id;

  PERFORM public.sync_payment_plan_status(p_plan_id);

  RETURN v_id;
END;
$$;

ALTER FUNCTION public.register_installment_payment(uuid, numeric, text, text, text, date) OWNER TO postgres;
ALTER FUNCTION public.register_advance_payment(uuid, uuid[], text, text, text, date) OWNER TO postgres;
ALTER FUNCTION public.void_installment_payment(uuid, text) OWNER TO postgres;
ALTER FUNCTION public.reject_client_voucher(uuid, text) OWNER TO postgres;
ALTER FUNCTION public.create_payment_plan(jsonb) OWNER TO postgres;
ALTER FUNCTION public.apply_prepayment(uuid, numeric, text, jsonb, text, text, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.register_installment_payment(uuid, numeric, text, text, text, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.register_advance_payment(uuid, uuid[], text, text, text, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_installment_payment(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reject_client_voucher(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_payment_plan(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_prepayment(uuid, numeric, text, jsonb, text, text, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.register_installment_payment(uuid, numeric, text, text, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_advance_payment(uuid, uuid[], text, text, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_installment_payment(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_client_voucher(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_payment_plan(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_prepayment(uuid, numeric, text, jsonb, text, text, text) TO authenticated;

COMMENT ON TABLE public.installment_payments IS
  'Libro de pagos de cuotas: una fila por pago o parte. No se borra; se anula (voided_at, void_reason). legacy = copia de cuotas pagadas antes de 084.';
COMMENT ON COLUMN public.installments.declared_amount IS
  'Monto que el cliente declara en su voucher (puede ser una parte). Se limpia al aprobar o rechazar.';
COMMENT ON TABLE public.account_module_members IS
  'Permisos explícitos por módulo (cobranzas, legal, cronograma, ventas), además del área del perfil.';

COMMIT;

-- PostgREST lee el esquema nuevo sin reiniciar.
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Golden Habitat (lo corre el dueño, una vez, después de revisar):
-- mora S/ 6 diaria desde el 2.º día, tope 60 días, hasta 3 partes por
-- cuota, causal de resolución con 2 cuotas o 60 días.
-- ============================================================
-- UPDATE public.accounts
--    SET late_fee_type = 'diaria',
--        late_fee_value = 6,
--        late_fee_grace_days = 1,
--        late_fee_cap_days = 60,
--        max_payment_parts = 3,
--        resolution_installments = 2,
--        resolution_days = 60
--  WHERE name ILIKE '%golden%';
