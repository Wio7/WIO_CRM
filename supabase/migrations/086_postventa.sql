-- ============================================================
-- 086_postventa.sql — Postventa (Wio Suite, fase F2)
--
-- Diseño: docs/superpowers/specs/2026-11-09-fase-f-apps-y-conexiones-design.md §6.2
--         y docs/superpowers/specs/2026-11-09-areas-pendientes-design.md §3.4
-- Casos:  supabase/tests/086_casos.sql (correr DESPUÉS de aplicar esta).
-- Requiere: 049_agenda.sql y 085_conexiones.sql aplicadas.
--
-- Qué cambia:
--   1. Tabla postventa_cases: un caso por traspaso aceptado hacia postventa.
--      Solo guarda la referencia (traspaso + contacto); el cliente, el lote
--      y la nota de origen se leen del registro original. Nadie escribe
--      directo: solo los RPC de aquí.
--   2. accept_handoff (085) se extiende de forma compatible: igual que
--      antes y, si el destino es postventa, abre el caso.
--   3. RPCs: postventa_cases_list, postventa_schedule_visit,
--      postventa_resolve_case.
--      Visitas: solo lunes y sábado (hora de Lima), con al menos 7 días de
--      anticipación, dentro de una franja de staff_availability de quien
--      atiende el caso, y un solo cliente por franja. Constantes en
--      postventa_visit_rules().
--   4. my_module_access() suma 'postventa'.
--   5. Alejandro (perfil "Asesor Golden 03") queda con el módulo postventa.
--
-- Estados del caso: nuevo -> agendado -> resuelto (resolver exige nota; se
-- puede resolver desde nuevo o agendado). Devolver al área de origen se
-- hace antes de aceptar, con return_handoff (085).
--
-- Idempotente — se puede volver a correr.
-- ============================================================
BEGIN;

-- ============================================================
-- 1. Tabla de casos
-- ============================================================
CREATE TABLE IF NOT EXISTS public.postventa_cases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Un traspaso aceptado abre un solo caso.
  handoff_id       uuid NOT NULL UNIQUE REFERENCES public.module_handoffs(id) ON DELETE CASCADE,
  -- Solo la referencia al cliente (sin copiar sus datos).
  contact_id       uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  topic            text NOT NULL
                     CHECK (topic IN ('ubicacion', 'avance_obra', 'entrega', 'documentos', 'otro')),
  origin           text NOT NULL CHECK (origin IN ('cobranzas', 'legal')),
  status           text NOT NULL DEFAULT 'nuevo' CHECK (status IN ('nuevo', 'agendado', 'resuelto')),
  appointment_id   uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  resolution_note  text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
  assigned_to      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  CONSTRAINT postventa_cases_resolved_has_note CHECK (status <> 'resuelto' OR resolution_note IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_postventa_cases_account
  ON public.postventa_cases(account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_postventa_cases_contact
  ON public.postventa_cases(contact_id);

DROP TRIGGER IF EXISTS postventa_cases_updated_at ON public.postventa_cases;
CREATE TRIGGER postventa_cases_updated_at
  BEFORE UPDATE ON public.postventa_cases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ¿El usuario actual es de postventa? Módulo explícito, dueño/super admin
-- (can_access_module) o área gerencia. Solo lectura y gestión de casos.
CREATE OR REPLACE FUNCTION public.postventa_has_access(p_account_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.can_access_module(p_account_id, 'postventa')
      OR public.is_owner_or_gerencia(p_account_id);
$$;
ALTER FUNCTION public.postventa_has_access(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.postventa_has_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.postventa_has_access(uuid) TO anon, authenticated, service_role;

ALTER TABLE public.postventa_cases ENABLE ROW LEVEL SECURITY;
-- Solo lectura para usuarios; escriben los RPC (dueño postgres).
REVOKE ALL ON public.postventa_cases FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.postventa_cases FROM authenticated;
GRANT SELECT ON public.postventa_cases TO authenticated;

DROP POLICY IF EXISTS postventa_cases_select ON public.postventa_cases;
CREATE POLICY postventa_cases_select ON public.postventa_cases FOR SELECT
  USING (public.postventa_has_access(account_id));

-- Reglas de las visitas, en un solo sitio.
--   dias: días de la semana permitidos (0 = domingo … 6 = sábado)
--   anticipacion_dias: mínimo de días entre hoy (hora de Lima) y la visita
CREATE OR REPLACE FUNCTION public.postventa_visit_rules(
  OUT dias integer[],
  OUT anticipacion_dias integer
)
LANGUAGE sql IMMUTABLE
AS $$
  SELECT ARRAY[1, 6], 7;
$$;
REVOKE ALL ON FUNCTION public.postventa_visit_rules() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postventa_visit_rules() TO authenticated;

-- ============================================================
-- 2. accept_handoff: lo de 085 + abrir el caso de postventa
-- ============================================================
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

  IF v_h.to_module = 'postventa' AND v_h.entity_type = 'contact' THEN
    INSERT INTO postventa_cases (account_id, handoff_id, contact_id, topic, origin, assigned_to)
    VALUES (v_h.account_id, v_h.id, v_h.entity_id, COALESCE(v_h.topic, 'otro'), v_h.from_module, auth.uid())
    ON CONFLICT (handoff_id) DO NOTHING;
  END IF;
END;
$$;

ALTER FUNCTION public.accept_handoff(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accept_handoff(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_handoff(uuid) TO authenticated;

-- Traspasos a postventa ya aceptados antes de esta migración: abren su caso.
INSERT INTO public.postventa_cases (account_id, handoff_id, contact_id, topic, origin, assigned_to, created_at)
SELECT h.account_id, h.id, h.entity_id, COALESCE(h.topic, 'otro'), h.from_module, h.handled_by,
       COALESCE(h.handled_at, h.created_at)
  FROM public.module_handoffs h
 WHERE h.to_module = 'postventa' AND h.entity_type = 'contact' AND h.status = 'aceptado'
   AND h.from_module IN ('cobranzas', 'legal')
   AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = h.entity_id AND c.account_id = h.account_id)
ON CONFLICT (handoff_id) DO NOTHING;

-- ============================================================
-- 3. RPCs de postventa
-- ============================================================

-- ------------------------------------------------------------
-- postventa_cases_list — casos de la cuenta (con el módulo; si no, vacía).
-- p_status NULL = todos. Orden: nuevo, agendado, resuelto; más nuevos antes.
-- El resumen (cliente, lote, proyecto) lo arma el servidor desde el
-- registro original; la nota es la del traspaso.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.postventa_cases_list(p_status text DEFAULT NULL)
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
  IF p_status IS NOT NULL AND p_status NOT IN ('nuevo', 'agendado', 'resuelto') THEN
    RAISE EXCEPTION 'Estado desconocido: %', p_status USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account FROM profiles WHERE user_id = auth.uid();
  IF v_account IS NULL OR NOT public.postventa_has_access(v_account) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT jsonb_build_object(
           'id',               c.id,
           'handoff_id',       c.handoff_id,
           'contact_id',       c.contact_id,
           'status',           c.status,
           'topic',            c.topic,
           'origin',           c.origin,
           'note',             h.note,
           'sent_by_name',     sp.full_name,
           'assigned_to',      c.assigned_to,
           'assigned_to_name', ap.full_name,
           'created_at',       c.created_at,
           'resolved_at',      c.resolved_at,
           'resolution_note',  c.resolution_note,
           'summary',          public.handoff_summary(h.kind, c.contact_id, c.account_id),
           'appointment',      CASE WHEN a.id IS NULL THEN 'null'::jsonb
                                    ELSE jsonb_build_object('id', a.id, 'starts_at', a.starts_at,
                                                            'minutes', a.minutes, 'status', a.status) END)
    FROM postventa_cases c
    JOIN module_handoffs h ON h.id = c.handoff_id
    LEFT JOIN profiles sp ON sp.user_id = h.sent_by
    LEFT JOIN profiles ap ON ap.user_id = c.assigned_to
    LEFT JOIN appointments a ON a.id = c.appointment_id
   WHERE c.account_id = v_account
     AND (p_status IS NULL OR c.status = p_status)
   ORDER BY CASE c.status WHEN 'nuevo' THEN 0 WHEN 'agendado' THEN 1 ELSE 2 END,
            c.created_at DESC, c.id DESC;
END;
$$;

-- ------------------------------------------------------------
-- postventa_schedule_visit — agenda (o reagenda) la visita de un caso.
-- p_starts_at tiene que ser el inicio exacto de una franja de
-- staff_availability de quien atiende el caso. Devuelve la cita.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.postventa_schedule_visit(p_case_id uuid, p_starts_at timestamptz)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
  v_case    postventa_cases%ROWTYPE;
  v_rules   record;
  v_local   timestamp;
  v_day     date;
  v_dow     integer;
  v_min     integer;
  v_staff   uuid;
  v_ends    integer;
  v_minutes integer;
  v_end     timestamptz;
  v_appt    uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501';
  END IF;
  IF p_starts_at IS NULL THEN
    RAISE EXCEPTION 'Elige la fecha y la hora' USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account FROM profiles WHERE user_id = auth.uid();
  SELECT * INTO v_case FROM postventa_cases WHERE id = p_case_id AND account_id = v_account FOR UPDATE;
  IF NOT FOUND OR NOT public.postventa_has_access(v_case.account_id) THEN
    RAISE EXCEPTION 'Caso no encontrado' USING ERRCODE = '42501';
  END IF;
  IF v_case.status = 'resuelto' THEN
    RAISE EXCEPTION 'El caso ya está resuelto' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_rules FROM public.postventa_visit_rules();
  v_local := p_starts_at AT TIME ZONE 'America/Lima';
  v_day   := v_local::date;
  v_dow   := extract(dow FROM v_local)::integer;
  v_min   := (extract(hour FROM v_local) * 60 + extract(minute FROM v_local))::integer;

  IF NOT (v_dow = ANY (v_rules.dias)) THEN
    RAISE EXCEPTION 'Las visitas son solo los lunes y los sábados' USING ERRCODE = '22023';
  END IF;
  IF v_day < (now() AT TIME ZONE 'America/Lima')::date + v_rules.anticipacion_dias THEN
    RAISE EXCEPTION 'Las visitas se agendan con al menos % días de anticipación', v_rules.anticipacion_dias
      USING ERRCODE = '22023';
  END IF;

  -- Quien atiende el caso (si quedó sin asignar, quien agenda).
  v_staff := COALESCE(v_case.assigned_to, auth.uid());
  SELECT s.ends_min INTO v_ends
    FROM staff_availability s
   WHERE s.account_id = v_case.account_id AND s.user_id = v_staff
     AND s.weekday = v_dow AND s.starts_min = v_min
     AND extract(second FROM v_local) = 0;
  IF v_ends IS NULL THEN
    RAISE EXCEPTION 'Esa hora no es una franja de visita' USING ERRCODE = '22023';
  END IF;
  v_minutes := LEAST(GREATEST(v_ends - v_min, 10), 240);
  v_end := p_starts_at + make_interval(mins => v_minutes);

  -- Un cliente por franja (la cita vigente de este mismo caso no cuenta).
  IF EXISTS (SELECT 1 FROM appointments a
              WHERE a.user_id = v_staff AND a.status = 'agendada'
                AND a.id IS DISTINCT FROM v_case.appointment_id
                AND a.starts_at < v_end
                AND a.starts_at + make_interval(mins => a.minutes) > p_starts_at) THEN
    RAISE EXCEPTION 'Esa franja ya está ocupada' USING ERRCODE = '23505';
  END IF;

  IF v_case.appointment_id IS NOT NULL THEN
    UPDATE appointments SET status = 'cancelada'
     WHERE id = v_case.appointment_id AND status = 'agendada';
  END IF;

  BEGIN
    INSERT INTO appointments (account_id, contact_id, user_id, starts_at, minutes, kind, created_by, notes)
    VALUES (v_case.account_id, v_case.contact_id, v_staff, p_starts_at, v_minutes, 'visita', 'equipo',
            'Postventa: ' || v_case.topic)
    RETURNING id INTO v_appt;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Esa franja ya está ocupada' USING ERRCODE = '23505';
  END;

  UPDATE postventa_cases SET status = 'agendado', appointment_id = v_appt WHERE id = v_case.id;
  RETURN v_appt;
END;
$$;

-- ------------------------------------------------------------
-- postventa_resolve_case — cierra el caso con una nota de resolución.
-- La visita agendada, si hay, queda cumplida.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.postventa_resolve_case(p_case_id uuid, p_note text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account uuid;
  v_case    postventa_cases%ROWTYPE;
  v_note    text := NULLIF(left(trim(p_note), 1000), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_account FROM profiles WHERE user_id = auth.uid();
  SELECT * INTO v_case FROM postventa_cases WHERE id = p_case_id AND account_id = v_account FOR UPDATE;
  IF NOT FOUND OR NOT public.postventa_has_access(v_case.account_id) THEN
    RAISE EXCEPTION 'Caso no encontrado' USING ERRCODE = '42501';
  END IF;
  IF v_case.status = 'resuelto' THEN
    RAISE EXCEPTION 'El caso ya está resuelto' USING ERRCODE = '55000';
  END IF;
  IF v_note IS NULL THEN
    RAISE EXCEPTION 'Escribe la nota de resolución' USING ERRCODE = '22023';
  END IF;

  IF v_case.appointment_id IS NOT NULL THEN
    UPDATE appointments SET status = 'cumplida'
     WHERE id = v_case.appointment_id AND status = 'agendada';
  END IF;

  UPDATE postventa_cases
     SET status = 'resuelto', resolution_note = v_note, resolved_at = now()
   WHERE id = v_case.id;
END;
$$;

ALTER FUNCTION public.postventa_cases_list(text) OWNER TO postgres;
ALTER FUNCTION public.postventa_schedule_visit(uuid, timestamptz) OWNER TO postgres;
ALTER FUNCTION public.postventa_resolve_case(uuid, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.postventa_cases_list(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.postventa_schedule_visit(uuid, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.postventa_resolve_case(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.postventa_cases_list(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.postventa_schedule_visit(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.postventa_resolve_case(uuid, text) TO authenticated;

-- ============================================================
-- 4. my_module_access suma 'postventa'
-- ============================================================
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
              'postventa',  public.postventa_has_access(p.account_id),
              'gerencia',   public.is_owner_or_gerencia(p.account_id))
       FROM public.profiles p WHERE p.user_id = auth.uid()),
    jsonb_build_object('cobranzas', false, 'legal', false, 'cronograma', false,
                       'ventas', false, 'postventa', false, 'gerencia', false));
$$;
ALTER FUNCTION public.my_module_access() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.my_module_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_module_access() TO authenticated;

COMMENT ON TABLE public.postventa_cases IS
  'Casos de postventa: uno por traspaso aceptado (handoff_id). Solo referencias; se escribe solo con accept_handoff, postventa_schedule_visit y postventa_resolve_case.';

-- ============================================================
-- 5. Alejandro (perfil "Asesor Golden 03") es de postventa
--    Si el perfil no existe (otra base), no inserta nada.
-- ============================================================
INSERT INTO public.account_module_members (account_id, user_id, module_key)
SELECT p.account_id, p.user_id, 'postventa'
  FROM public.profiles p
 WHERE p.user_id = '289a80e1-9d61-4e83-9b93-c91e1b843851'
   AND p.account_id = 'd74b5dfd-2999-4e2c-9a0e-10b3d540898b'
ON CONFLICT DO NOTHING;

UPDATE public.profiles
   SET full_name = 'Alejandro'
 WHERE user_id = '289a80e1-9d61-4e83-9b93-c91e1b843851'
   AND account_id = 'd74b5dfd-2999-4e2c-9a0e-10b3d540898b'
   AND full_name = 'Asesor Golden 03';

COMMIT;

-- PostgREST lee el esquema nuevo sin reiniciar.
NOTIFY pgrst, 'reload schema';
