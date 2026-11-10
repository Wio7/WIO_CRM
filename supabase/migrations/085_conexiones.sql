-- ============================================================
-- 085_conexiones.sql — Traspasos entre áreas (Wio Suite, fase F1)
--
-- Diseño: docs/superpowers/specs/2026-11-09-fase-f-apps-y-conexiones-design.md §4-§5.1
-- Casos:  supabase/tests/085_casos.sql (correr DESPUÉS de aplicar esta).
-- Requiere: 084_pagos_protegidos.sql aplicada.
--
-- Qué cambia:
--   1. Áreas: suma 'tecnica'. Módulos explícitos: suma 'postventa' (solo
--      por fila en account_module_members o acceso total; ningún área la
--      abre).
--   2. Tabla module_handoffs: un traspaso guarda solo la referencia
--      (entity_type + entity_id); lo que ve el destino lo arma el servidor
--      en my_handoffs. Nadie escribe directo: solo los RPC de aquí.
--   3. Conexiones (fijas aquí; tabla de verdad en src/lib/handoffs/kinds.ts):
--        pase_legal                 cobranzas → legal      plan de pagos
--        postventa_desde_cobranzas  cobranzas → postventa  contacto + tema
--        postventa_desde_legal      legal     → postventa  contacto + tema
--      Ningún traspaso mueve dinero ni crea planes. pase_legal deja la
--      gestión "Pase a legal" (084) en collection_actions.
--   4. RPCs: send_handoff, accept_handoff, return_handoff, my_handoffs,
--      handoff_destination_ready.
--
-- Idempotente — se puede volver a correr.
-- ============================================================
BEGIN;

-- ============================================================
-- 1. Áreas y módulos
-- ============================================================
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_area_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_area_check
  CHECK (area IS NULL OR area IN ('marketing', 'legal', 'cobranzas', 'ventas', 'gerencia', 'contabilidad', 'tecnica'));

-- set_member_area de 084 con 'tecnica' en la lista; el resto igual.
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
     AND p_area NOT IN ('marketing', 'legal', 'cobranzas', 'ventas', 'gerencia', 'contabilidad', 'tecnica') THEN
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

-- 'postventa' como módulo explícito. can_access_module (084) ya la
-- resuelve sin cambios: ningún área la abre (CASE … ELSE false), solo la
-- fila explícita o el acceso total.
ALTER TABLE public.account_module_members DROP CONSTRAINT IF EXISTS account_module_members_module_key_check;
ALTER TABLE public.account_module_members
  ADD CONSTRAINT account_module_members_module_key_check
  CHECK (module_key IN ('cobranzas', 'legal', 'cronograma', 'ventas', 'postventa'));

-- ============================================================
-- 2. Tabla de traspasos
-- ============================================================
CREATE TABLE IF NOT EXISTS public.module_handoffs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind           text NOT NULL,
  from_module    text NOT NULL,
  to_module      text NOT NULL,
  -- Solo la referencia (sin FK: apunta a un plan o a un contacto según kind).
  entity_type    text NOT NULL,
  entity_id      uuid NOT NULL,
  topic          text,
  note           text,
  status         text NOT NULL DEFAULT 'pendiente'
                   CHECK (status IN ('pendiente', 'aceptado', 'devuelto')),
  return_reason  text,
  sent_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_to    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  handled_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  handled_at     timestamptz
);

-- Reglas de forma (con DO para poder re-correr).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'module_handoffs_kind_valid') THEN
    ALTER TABLE public.module_handoffs ADD CONSTRAINT module_handoffs_kind_valid CHECK (
      (kind = 'pase_legal'                AND from_module = 'cobranzas' AND to_module = 'legal'     AND entity_type = 'payment_plan')
   OR (kind = 'postventa_desde_cobranzas' AND from_module = 'cobranzas' AND to_module = 'postventa' AND entity_type = 'contact')
   OR (kind = 'postventa_desde_legal'     AND from_module = 'legal'     AND to_module = 'postventa' AND entity_type = 'contact'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'module_handoffs_topic_valid') THEN
    ALTER TABLE public.module_handoffs ADD CONSTRAINT module_handoffs_topic_valid CHECK (
      topic IS NULL OR topic IN ('ubicacion', 'avance_obra', 'entrega', 'documentos', 'otro'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'module_handoffs_text_length') THEN
    ALTER TABLE public.module_handoffs ADD CONSTRAINT module_handoffs_text_length CHECK (
      (note IS NULL OR char_length(note) <= 1000)
      AND (return_reason IS NULL OR char_length(return_reason) <= 1000));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'module_handoffs_return_has_reason') THEN
    ALTER TABLE public.module_handoffs ADD CONSTRAINT module_handoffs_return_has_reason CHECK (
      status <> 'devuelto' OR return_reason IS NOT NULL);
  END IF;
END $$;

-- Sin duplicados: un solo traspaso pendiente por cuenta, tipo y entidad
-- (un doble clic devuelve el mismo).
CREATE UNIQUE INDEX IF NOT EXISTS module_handoffs_one_pending
  ON public.module_handoffs(account_id, kind, entity_id) WHERE status = 'pendiente';
-- Bandejas: recibidos por destino, enviados por origen.
CREATE INDEX IF NOT EXISTS idx_module_handoffs_to
  ON public.module_handoffs(account_id, to_module, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_module_handoffs_from
  ON public.module_handoffs(account_id, from_module, created_at DESC);

ALTER TABLE public.module_handoffs ENABLE ROW LEVEL SECURITY;
-- Solo lectura para usuarios; escriben los RPC (dueño postgres).
REVOKE ALL ON public.module_handoffs FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.module_handoffs FROM authenticated;
GRANT SELECT ON public.module_handoffs TO authenticated;

-- ============================================================
-- 3. Ayudantes internos (solo los llaman los RPC de abajo)
-- ============================================================
-- ¿El usuario actual tiene el módulo? can_access_module (084) y, para
-- legal, también una fila en legal_members (Golden Legal 067 la admite
-- aunque no tenga área ni fila de módulo). legal_members es de otro repo:
-- si la tabla no existe, solo cuenta can_access_module. Solo para los
-- traspasos; can_access_module no cambia.
CREATE OR REPLACE FUNCTION public.handoff_has_module(p_account uuid, p_module text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_found boolean := false;
BEGIN
  IF public.can_access_module(p_account, p_module) THEN
    RETURN true;
  END IF;
  IF p_module IS DISTINCT FROM 'legal' OR auth.uid() IS NULL OR p_account IS NULL
     OR to_regclass('public.legal_members') IS NULL
     OR NOT public.is_account_member(p_account, 'viewer') THEN
    RETURN false;
  END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.legal_members m WHERE m.account_id = $1 AND m.user_id = $2)'
     INTO v_found USING p_account, auth.uid();
  RETURN COALESCE(v_found, false);
END;
$$;

ALTER FUNCTION public.handoff_has_module(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.handoff_has_module(uuid, text) FROM PUBLIC, anon;
-- La usa la política de lectura de abajo (corre como el usuario).
GRANT EXECUTE ON FUNCTION public.handoff_has_module(uuid, text) TO authenticated;

-- Lee la fila quien tiene el módulo origen o el destino.
DROP POLICY IF EXISTS module_handoffs_select ON public.module_handoffs;
CREATE POLICY module_handoffs_select ON public.module_handoffs FOR SELECT
  USING (public.handoff_has_module(account_id, from_module)
      OR public.handoff_has_module(account_id, to_module));

-- Ruta de cada tipo. Un tipo desconocido devuelve una fila de NULLs.
CREATE OR REPLACE FUNCTION public.handoff_route(
  p_kind text,
  OUT from_module text,
  OUT to_module text,
  OUT entity_type text
)
LANGUAGE sql IMMUTABLE SET search_path = public
AS $$
  SELECT r.f, r.t, r.e
    FROM (VALUES
      ('pase_legal',                'cobranzas', 'legal',     'payment_plan'),
      ('postventa_desde_cobranzas', 'cobranzas', 'postventa', 'contact'),
      ('postventa_desde_legal',     'legal',     'postventa', 'contact')
    ) AS r(k, f, t, e)
   WHERE r.k = p_kind;
$$;

-- Lo que ve el destino, armado desde el registro original y solo con los
-- campos de esa conexión. Corre como postgres (lo llama my_handoffs):
-- legal ve la deuda del caso aunque no lea payment_plan_balances.
CREATE OR REPLACE FUNCTION public.handoff_summary(p_kind text, p_entity_id uuid, p_account_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public
AS $$
  SELECT CASE
    WHEN p_kind = 'pase_legal' THEN (
      SELECT jsonb_build_object(
               'contact_id',      p.contact_id,
               'plan_id',         p.id,
               'cliente',         c.name,
               'telefono',        c.phone,
               'deuda_total',     b.pending_amount,
               'moneda',          p.currency,
               'cuotas_vencidas', b.overdue_count,
               'gestiones', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object('fecha', g.created_at, 'resultado', g.result, 'nota', g.note)
                                  ORDER BY g.created_at DESC, g.id DESC)
                   FROM (SELECT ca.id, ca.created_at, ca.result, ca.note
                           FROM public.collection_actions ca
                          WHERE ca.account_id = p.account_id
                            AND ca.contact_id = p.contact_id
                          ORDER BY ca.created_at DESC, ca.id DESC
                          LIMIT 5) g), '[]'::jsonb))
        FROM public.payment_plans p
        LEFT JOIN public.contacts c ON c.id = p.contact_id
        LEFT JOIN public.payment_plan_balances b ON b.plan_id = p.id
       WHERE p.id = p_entity_id AND p.account_id = p_account_id)
    WHEN p_kind IN ('postventa_desde_cobranzas', 'postventa_desde_legal') THEN (
      SELECT jsonb_build_object(
               'contact_id', c.id,
               'cliente',    c.name,
               'telefono',   c.phone,
               'lote', (SELECT string_agg(DISTINCT
                                 CASE WHEN NULLIF(trim(u.manzana), '') IS NULL THEN u.code
                                      ELSE u.manzana || '-' || u.code END, ', ')
                          FROM public.payment_plans pp
                          JOIN public.real_estate_units u ON u.id = pp.unit_id
                         WHERE pp.contact_id = c.id AND pp.account_id = c.account_id),
               'proyecto', (SELECT string_agg(DISTINCT rp.name, ', ')
                              FROM public.payment_plans pp
                              JOIN public.real_estate_units u ON u.id = pp.unit_id
                              JOIN public.real_estate_projects rp ON rp.id = u.project_id
                             WHERE pp.contact_id = c.id AND pp.account_id = c.account_id))
        FROM public.contacts c
       WHERE c.id = p_entity_id AND c.account_id = p_account_id)
  END;
$$;

ALTER FUNCTION public.handoff_route(text) OWNER TO postgres;
ALTER FUNCTION public.handoff_summary(text, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.handoff_route(text)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.handoff_summary(text, uuid, uuid)  FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 4. RPCs
-- ============================================================

-- ------------------------------------------------------------
-- send_handoff — envía un caso de un área a otra. Devuelve el id; si ya
-- hay uno pendiente del mismo tipo y entidad, devuelve ese (doble clic).
-- pase_legal registra la gestión "Pase a legal" solo cuando crea el
-- traspaso.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_handoff(
  p_kind      text,
  p_entity_id uuid,
  p_note      text DEFAULT NULL,
  p_topic     text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
  v_route   record;
  v_contact uuid;
  v_note    text := NULLIF(left(trim(p_note), 1000), '');
  v_topic   text := NULLIF(trim(p_topic), '');
  v_id      uuid;
  v_try     integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_route FROM public.handoff_route(p_kind);
  IF v_route.to_module IS NULL THEN
    RAISE EXCEPTION 'Tipo de traspaso desconocido: %', p_kind USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account FROM profiles WHERE user_id = auth.uid();
  IF v_account IS NULL OR NOT public.handoff_has_module(v_account, v_route.from_module) THEN
    RAISE EXCEPTION 'No tienes acceso al módulo %', v_route.from_module USING ERRCODE = '42501';
  END IF;

  IF v_route.entity_type = 'payment_plan' THEN
    SELECT contact_id INTO v_contact FROM payment_plans
     WHERE id = p_entity_id AND account_id = v_account;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Plan no encontrado' USING ERRCODE = '42501';
    END IF;
    IF v_contact IS NULL THEN
      RAISE EXCEPTION 'El plan no tiene cliente' USING ERRCODE = '22023';
    END IF;
    v_topic := NULL;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM contacts WHERE id = p_entity_id AND account_id = v_account) THEN
      RAISE EXCEPTION 'Cliente no encontrado' USING ERRCODE = '42501';
    END IF;
    IF v_topic IS NULL THEN
      RAISE EXCEPTION 'Elige el tema del caso' USING ERRCODE = '22023';
    END IF;
    IF v_topic NOT IN ('ubicacion', 'avance_obra', 'entrega', 'documentos', 'otro') THEN
      RAISE EXCEPTION 'Tema no válido: %', v_topic USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Si otro envío ganó la carrera, se devuelve el suyo; si ese ya se
  -- atendió entre medio, se vuelve a intentar.
  LOOP
    v_try := v_try + 1;
    INSERT INTO module_handoffs
      (account_id, kind, from_module, to_module, entity_type, entity_id, topic, note, sent_by)
    VALUES
      (v_account, p_kind, v_route.from_module, v_route.to_module, v_route.entity_type, p_entity_id,
       v_topic, v_note, auth.uid())
    ON CONFLICT (account_id, kind, entity_id) WHERE status = 'pendiente' DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NOT NULL THEN
      IF p_kind = 'pase_legal' THEN
        INSERT INTO collection_actions (account_id, contact_id, plan_id, channel, result, note, created_by)
        VALUES (v_account, v_contact, p_entity_id, 'otro', 'pase_legal', v_note, auth.uid());
      END IF;
      RETURN v_id;
    END IF;

    SELECT id INTO v_id FROM module_handoffs
     WHERE account_id = v_account AND kind = p_kind AND entity_id = p_entity_id AND status = 'pendiente';
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;

    IF v_try >= 3 THEN
      RAISE EXCEPTION 'No se pudo enviar el caso; vuelve a intentarlo';
    END IF;
  END LOOP;
END;
$$;

-- ------------------------------------------------------------
-- accept_handoff — el área destino toma el caso. Dos a la vez: gana uno,
-- el otro recibe "Ya lo tomó <nombre>".
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_handoff(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
  v_h       module_handoffs%ROWTYPE;
  v_name    text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_account FROM profiles WHERE user_id = auth.uid();
  SELECT * INTO v_h FROM module_handoffs WHERE id = p_id AND account_id = v_account FOR UPDATE;
  IF NOT FOUND OR NOT public.handoff_has_module(v_h.account_id, v_h.to_module) THEN
    RAISE EXCEPTION 'Traspaso no encontrado' USING ERRCODE = '42501';
  END IF;

  IF v_h.status <> 'pendiente' THEN
    SELECT full_name INTO v_name FROM profiles WHERE user_id = v_h.handled_by;
    RAISE EXCEPTION 'Ya lo tomó %', COALESCE(NULLIF(trim(v_name), ''), 'otra persona') USING ERRCODE = '55000';
  END IF;

  UPDATE module_handoffs
     SET status = 'aceptado', handled_by = auth.uid(), handled_at = now()
   WHERE id = v_h.id;
END;
$$;

-- ------------------------------------------------------------
-- return_handoff — el área destino lo devuelve al origen con un motivo.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.return_handoff(p_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
  v_reason  text := NULLIF(left(trim(p_reason), 1000), '');
  v_h       module_handoffs%ROWTYPE;
  v_name    text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Escribe el motivo' USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account FROM profiles WHERE user_id = auth.uid();
  SELECT * INTO v_h FROM module_handoffs WHERE id = p_id AND account_id = v_account FOR UPDATE;
  IF NOT FOUND OR NOT public.handoff_has_module(v_h.account_id, v_h.to_module) THEN
    RAISE EXCEPTION 'Traspaso no encontrado' USING ERRCODE = '42501';
  END IF;

  IF v_h.status <> 'pendiente' THEN
    SELECT full_name INTO v_name FROM profiles WHERE user_id = v_h.handled_by;
    RAISE EXCEPTION 'Ya lo tomó %', COALESCE(NULLIF(trim(v_name), ''), 'otra persona') USING ERRCODE = '55000';
  END IF;

  UPDATE module_handoffs
     SET status = 'devuelto', return_reason = v_reason, handled_by = auth.uid(), handled_at = now()
   WHERE id = v_h.id;
END;
$$;

-- ------------------------------------------------------------
-- my_handoffs — bandeja de un módulo: 'recibidos' (destino) o
-- 'enviados' (origen). Sin el módulo, vacía. Más nuevos primero.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_handoffs(p_module text, p_box text)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501';
  END IF;
  IF p_box IS NULL OR p_box NOT IN ('recibidos', 'enviados') THEN
    RAISE EXCEPTION 'Bandeja desconocida: %', p_box USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account FROM profiles WHERE user_id = auth.uid();
  IF v_account IS NULL OR p_module IS NULL OR NOT public.handoff_has_module(v_account, p_module) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT jsonb_build_object(
           'id',              h.id,
           'kind',            h.kind,
           'status',          h.status,
           'topic',           h.topic,
           'note',            h.note,
           'return_reason',   h.return_reason,
           'sent_by_name',    sp.full_name,
           'handled_by_name', hp.full_name,
           'created_at',      h.created_at,
           'handled_at',      h.handled_at,
           'summary',         public.handoff_summary(h.kind, h.entity_id, h.account_id))
    FROM module_handoffs h
    LEFT JOIN profiles sp ON sp.user_id = h.sent_by
    LEFT JOIN profiles hp ON hp.user_id = h.handled_by
   WHERE h.account_id = v_account
     AND CASE WHEN p_box = 'recibidos' THEN h.to_module = p_module
              ELSE h.from_module = p_module END
   ORDER BY h.created_at DESC, h.id DESC;
END;
$$;

-- ------------------------------------------------------------
-- handoff_destination_ready — ¿hay alguien en el área destino? Cuenta
-- solo personas (agente o admin) con fila explícita del módulo destino
-- y, para legal, también el área 'legal' o una fila en legal_members
-- (como handoff_has_module). El dueño y el super admin no cuentan
-- (entran a todo; si contaran, siempre sería true).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handoff_destination_ready(p_kind text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
  v_to      text;
  v_found   boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  SELECT r.to_module INTO v_to FROM public.handoff_route(p_kind) r;
  SELECT account_id INTO v_account FROM profiles WHERE user_id = auth.uid();
  IF v_to IS NULL OR v_account IS NULL THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1 FROM profiles p
     WHERE p.account_id = v_account
       AND p.account_role IN ('admin', 'agent')
       AND NOT EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id = p.user_id)
       AND (EXISTS (SELECT 1 FROM account_module_members m
                     WHERE m.account_id = v_account
                       AND m.user_id = p.user_id
                       AND m.module_key = v_to)
            OR (v_to = 'legal' AND p.area = 'legal'))) THEN
    RETURN true;
  END IF;

  -- Equipo de Golden Legal (tabla de otro repo; puede no existir).
  IF v_to = 'legal' AND to_regclass('public.legal_members') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (
               SELECT 1 FROM public.legal_members m
                 JOIN public.profiles p ON p.user_id = m.user_id AND p.account_id = m.account_id
                WHERE m.account_id = $1
                  AND p.account_role IN (''admin'', ''agent'', ''viewer'')
                  AND NOT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = p.user_id))'
       INTO v_found USING v_account;
  END IF;
  RETURN COALESCE(v_found, false);
END;
$$;

ALTER FUNCTION public.send_handoff(text, uuid, text, text) OWNER TO postgres;
ALTER FUNCTION public.accept_handoff(uuid) OWNER TO postgres;
ALTER FUNCTION public.return_handoff(uuid, text) OWNER TO postgres;
ALTER FUNCTION public.my_handoffs(text, text) OWNER TO postgres;
ALTER FUNCTION public.handoff_destination_ready(text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.send_handoff(text, uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.accept_handoff(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.return_handoff(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_handoffs(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.handoff_destination_ready(text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.send_handoff(text, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_handoff(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.return_handoff(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_handoffs(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.handoff_destination_ready(text) TO authenticated;

COMMENT ON TABLE public.module_handoffs IS
  'Traspasos entre áreas: solo la referencia (entity_type + entity_id); el resumen lo arma my_handoffs. Se escribe solo con send_handoff, accept_handoff y return_handoff.';
COMMENT ON TABLE public.account_module_members IS
  'Permisos explícitos por módulo (cobranzas, legal, cronograma, ventas, postventa), además del área del perfil. Postventa solo por esta tabla.';

COMMIT;

-- PostgREST lee el esquema nuevo sin reiniciar.
NOTIFY pgrst, 'reload schema';
