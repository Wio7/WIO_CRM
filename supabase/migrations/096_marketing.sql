-- ============================================================
-- 096_marketing.sql — Base de la app de Marketing de Golden
--
-- Pedido de Bryce (2026-11-13): el equipo de marketing de Golden Habitat (un
-- jefe y su equipo) tiene su propia app, como Cobranzas y Administración, con
-- Resumen y Leads (solo el jefe), Calendario de contenido y Tareas (todos).
-- Esta migración deja la base de datos lista. El contrato de nombres está en
-- el plan "App de Marketing de Golden (F6)".
--
-- SOLO AGREGA objetos nuevos; no reemplaza ninguna función existente
-- (can_access_module y my_module_access quedan como están). Crea:
--   1. marketing_members: quién es jefe o equipo (account_id, user_id, role).
--   2. marketing_role(cuenta) y marketing_my_access(): rol del usuario.
--        jefe   = dueño/super admin/área gerencia (is_owner_or_gerencia, 084)
--                 o fila 'jefe' en marketing_members.
--        equipo = fila 'equipo' o perfil con area = 'marketing' sin fila.
--        NULL   = cualquier otro (cobranzas, promueve, administración...).
--   3. marketing_pieces (calendario de contenido) con RLS, un trigger que
--      protege la aprobación y marketing_review_piece (solo el jefe).
--   4. marketing_tasks (tablero) con RLS; cada pieza nueva crea su tarea y
--      al publicarse la tarea pasa a 'listo'.
--   5. Bucket privado 'marketing' en Storage (50 MB, imagen y video) y sus
--      políticas: ruta {account_id}/{piece_id}/{archivo}.
--   6. marketing_summary(mes, proyecto) y marketing_leads(mes, proyecto):
--      solo el jefe (si no: 'Solo el jefe de marketing', 42501). Sin montos de
--      cobranza ni cuotas.
--
-- Relación lead -> proyecto (revisada en 032): el contacto no trae proyecto.
-- La única relación es por la separación: contacts <- reservations.contact_id
-- -> reservation_units -> real_estate_units.project_id. Se usa así:
--   - marketing_leads: projectId/projectName salen de la primera separación
--     (no rechazada) del contacto; el filtro p_project muestra los leads que
--     separaron en ese proyecto. Un lead sin separación no tiene proyecto.
--   - marketing_summary: p_project filtra el gasto y las separaciones; los
--     leads (leadsTotal, por canal, costo por lead) NO se filtran porque un
--     lead aún no separado no tiene proyecto (filtrarlos daría un costo por
--     lead falso). Es el caso "no hay relación" del contrato para los leads.
--
-- Gasto vigente (criterio de 087 cash_management_panel / 095): kind 'expense',
-- sin ser anulación, sin que exista otra fila con reversal_of apuntando a él,
-- y sin transferencia entre cajas. Rubro 'marketing', cualquier caja de la
-- cuenta, por occurred_on.
--
-- Fuera de una sesión de usuario (auth.uid() NULL: SQL Editor, service role)
-- el trigger de piezas no aplica los candados de rol.
--
-- Casos: supabase/tests/096_casos.sql (correr DESPUÉS de aplicar esta; corre
-- como postgres en el SQL Editor y termina en ROLLBACK).
-- Idempotente — se puede volver a correr.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. Miembros de marketing
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketing_members (
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('jefe', 'equipo')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);

-- ------------------------------------------------------------
-- 2. Rol de marketing
-- ------------------------------------------------------------
-- Rol de un usuario concreto (uso interno: no se concede a authenticated para
-- que nadie consulte el rol de otras personas). Mismo criterio que
-- is_owner_or_gerencia, pero por usuario.
CREATE OR REPLACE FUNCTION public.marketing_role_of(p_account uuid, p_user uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_account IS NULL OR p_user IS NULL THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = p_user AND p.account_id = p_account) THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.user_id = p_user AND p.account_id = p_account
                    AND (p.account_role = 'owner' OR p.area = 'gerencia'))
      OR EXISTS (SELECT 1 FROM public.marketing_members m
                  WHERE m.account_id = p_account AND m.user_id = p_user AND m.role = 'jefe') THEN 'jefe'
    WHEN EXISTS (SELECT 1 FROM public.marketing_members m
                  WHERE m.account_id = p_account AND m.user_id = p_user AND m.role = 'equipo')
      OR EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.user_id = p_user AND p.account_id = p_account AND p.area = 'marketing') THEN 'equipo'
    ELSE NULL
  END;
$$;
ALTER FUNCTION public.marketing_role_of(uuid, uuid) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.marketing_role(p_account uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN auth.uid() IS NULL OR p_account IS NULL THEN NULL
    WHEN public.is_owner_or_gerencia(p_account) THEN 'jefe'
    ELSE public.marketing_role_of(p_account, auth.uid())
  END;
$$;
ALTER FUNCTION public.marketing_role(uuid) OWNER TO postgres;

ALTER TABLE public.marketing_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_members FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_members TO authenticated;
DROP POLICY IF EXISTS marketing_members_select ON public.marketing_members;
CREATE POLICY marketing_members_select ON public.marketing_members FOR SELECT
  USING (public.marketing_role(account_id) IS NOT NULL);
DROP POLICY IF EXISTS marketing_members_write ON public.marketing_members;
CREATE POLICY marketing_members_write ON public.marketing_members FOR ALL
  USING (public.is_owner_or_gerencia(account_id))
  WITH CHECK (public.is_owner_or_gerencia(account_id));

CREATE OR REPLACE FUNCTION public.marketing_my_access()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_role text;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  v_role := public.marketing_role(a);
  RETURN jsonb_build_object(
    'accountId', a,
    'role', v_role,
    'userId', auth.uid(),
    'projects', CASE WHEN v_role IS NULL THEN '[]'::jsonb ELSE COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name) ORDER BY r.name)
          FROM public.real_estate_projects r WHERE r.account_id = a), '[]'::jsonb) END,
    'team', CASE WHEN v_role IS NULL THEN '[]'::jsonb ELSE COALESCE((
        SELECT jsonb_agg(jsonb_build_object('userId', t.user_id, 'name', t.name, 'role', t.rol) ORDER BY t.name)
          FROM (SELECT p.user_id, COALESCE(NULLIF(p.full_name, ''), p.email) AS name,
                       public.marketing_role_of(a, p.user_id) AS rol
                  FROM public.profiles p WHERE p.account_id = a) t
         WHERE t.rol IS NOT NULL), '[]'::jsonb) END);
END;
$$;
ALTER FUNCTION public.marketing_my_access() OWNER TO postgres;

-- ------------------------------------------------------------
-- 3. Piezas del calendario
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketing_pieces (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  title        text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 140),
  network      text NOT NULL CHECK (network IN ('instagram', 'facebook', 'tiktok', 'whatsapp')),
  format       text CHECK (format IS NULL OR format IN ('post', 'carrusel', 'reel', 'historia', 'video', 'estado', 'difusion')),
  project_id   uuid REFERENCES public.real_estate_projects(id) ON DELETE SET NULL,
  scheduled_on date NOT NULL,
  caption      text CHECK (caption IS NULL OR char_length(caption) <= 2200),
  status       text NOT NULL DEFAULT 'borrador'
                 CHECK (status IN ('borrador', 'en_revision', 'aprobada', 'devuelta', 'publicada')),
  media_path   text,
  media_type   text CHECK (media_type IS NULL OR media_type IN ('image', 'video')),
  assignee     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by   uuid NOT NULL DEFAULT auth.uid(),
  reviewed_by  uuid,
  review_note  text,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_pieces_account_date ON public.marketing_pieces(account_id, scheduled_on);

-- Candados de la aprobación: el equipo no aprueba ni devuelve; publicar solo
-- desde 'aprobada'; reabrir una publicada solo el jefe.
CREATE OR REPLACE FUNCTION public.marketing_pieces_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_role text;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    v_role := public.marketing_role(NEW.account_id);
    IF TG_OP = 'INSERT' THEN
      IF v_role IS DISTINCT FROM 'jefe' THEN
        IF NEW.status NOT IN ('borrador', 'en_revision') THEN
          RAISE EXCEPTION 'Solo el jefe de marketing aprueba o publica' USING ERRCODE = '42501'; END IF;
        NEW.reviewed_by := NULL;
        NEW.review_note := NULL;
      END IF;
    ELSE
      IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
        RAISE EXCEPTION 'No se puede cambiar de cuenta una pieza' USING ERRCODE = '42501'; END IF;
      IF v_role IS DISTINCT FROM 'jefe'
         AND (NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by OR NEW.review_note IS DISTINCT FROM OLD.review_note) THEN
        RAISE EXCEPTION 'Solo el jefe de marketing revisa las piezas' USING ERRCODE = '42501'; END IF;
      IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NEW.status IN ('aprobada', 'devuelta') AND v_role IS DISTINCT FROM 'jefe' THEN
          RAISE EXCEPTION 'Solo el jefe de marketing aprueba o devuelve' USING ERRCODE = '42501'; END IF;
        IF NEW.status = 'publicada' AND OLD.status <> 'aprobada' THEN
          RAISE EXCEPTION 'Una pieza solo se publica después de aprobada' USING ERRCODE = '22023'; END IF;
        IF OLD.status = 'publicada' AND v_role IS DISTINCT FROM 'jefe' THEN
          RAISE EXCEPTION 'Solo el jefe de marketing reabre una pieza publicada' USING ERRCODE = '42501'; END IF;
      END IF;
      -- Si el equipo cambia el contenido de una pieza ya aprobada, vuelve a revisión:
      -- el jefe tiene que ver la versión que se publica.
      IF v_role IS DISTINCT FROM 'jefe' AND OLD.status = 'aprobada' AND NEW.status = 'aprobada'
         AND (NEW.title IS DISTINCT FROM OLD.title OR NEW.caption IS DISTINCT FROM OLD.caption
              OR NEW.media_path IS DISTINCT FROM OLD.media_path OR NEW.network IS DISTINCT FROM OLD.network
              OR NEW.format IS DISTINCT FROM OLD.format) THEN
        NEW.status := 'en_revision';
      END IF;
    END IF;
  END IF;
  IF NEW.status = 'publicada' THEN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'publicada' OR NEW.published_at IS NULL THEN
      NEW.published_at := COALESCE(NEW.published_at, now()); END IF;
  ELSE
    NEW.published_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.marketing_pieces_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.marketing_pieces_guard() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS marketing_pieces_guard ON public.marketing_pieces;
CREATE TRIGGER marketing_pieces_guard BEFORE INSERT OR UPDATE ON public.marketing_pieces
  FOR EACH ROW EXECUTE FUNCTION public.marketing_pieces_guard();
DROP TRIGGER IF EXISTS marketing_pieces_updated ON public.marketing_pieces;
CREATE TRIGGER marketing_pieces_updated BEFORE UPDATE ON public.marketing_pieces
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.marketing_pieces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_pieces FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_pieces TO authenticated;
DROP POLICY IF EXISTS marketing_pieces_select ON public.marketing_pieces;
CREATE POLICY marketing_pieces_select ON public.marketing_pieces FOR SELECT
  USING (public.marketing_role(account_id) IS NOT NULL);
DROP POLICY IF EXISTS marketing_pieces_insert ON public.marketing_pieces;
CREATE POLICY marketing_pieces_insert ON public.marketing_pieces FOR INSERT
  WITH CHECK (public.marketing_role(account_id) IS NOT NULL);
DROP POLICY IF EXISTS marketing_pieces_update ON public.marketing_pieces;
CREATE POLICY marketing_pieces_update ON public.marketing_pieces FOR UPDATE
  USING (public.marketing_role(account_id) IS NOT NULL)
  WITH CHECK (public.marketing_role(account_id) IS NOT NULL);
DROP POLICY IF EXISTS marketing_pieces_delete ON public.marketing_pieces;
CREATE POLICY marketing_pieces_delete ON public.marketing_pieces FOR DELETE
  USING (public.marketing_role(account_id) = 'jefe'
         OR (public.marketing_role(account_id) IS NOT NULL AND created_by = auth.uid() AND status = 'borrador'));

-- Aprobar o devolver: solo el jefe, con nota obligatoria al devolver.
CREATE OR REPLACE FUNCTION public.marketing_review_piece(p_piece uuid, p_approve boolean, p_note text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_acc uuid;
  v_status text;
BEGIN
  SELECT account_id, status INTO v_acc, v_status FROM public.marketing_pieces WHERE id = p_piece FOR UPDATE;
  IF v_acc IS NULL OR public.marketing_role(v_acc) IS NULL THEN
    RAISE EXCEPTION 'Pieza no encontrada' USING ERRCODE = 'P0002'; END IF;
  IF public.marketing_role(v_acc) <> 'jefe' THEN
    RAISE EXCEPTION 'Solo el jefe de marketing' USING ERRCODE = '42501'; END IF;
  IF v_status = 'publicada' THEN
    RAISE EXCEPTION 'La pieza ya está publicada' USING ERRCODE = '22023'; END IF;
  IF NOT COALESCE(p_approve, false) AND length(btrim(COALESCE(p_note, ''))) = 0 THEN
    RAISE EXCEPTION 'Escribe una nota al devolver la pieza' USING ERRCODE = '22023'; END IF;
  UPDATE public.marketing_pieces
     SET status = CASE WHEN p_approve THEN 'aprobada' ELSE 'devuelta' END,
         reviewed_by = auth.uid(),
         review_note = NULLIF(btrim(COALESCE(p_note, '')), '')
   WHERE id = p_piece;
END;
$$;
ALTER FUNCTION public.marketing_review_piece(uuid, boolean, text) OWNER TO postgres;

-- ------------------------------------------------------------
-- 4. Tareas
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.marketing_tasks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  title      text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 140),
  kind       text NOT NULL DEFAULT 'otro' CHECK (kind IN ('pieza', 'grabar', 'editar', 'diseno', 'cotizar', 'otro')),
  status     text NOT NULL DEFAULT 'por_hacer' CHECK (status IN ('por_hacer', 'en_curso', 'listo')),
  assignee   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  due_on     date,
  piece_id   uuid REFERENCES public.marketing_pieces(id) ON DELETE CASCADE,
  notes      text,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_tasks_account_status ON public.marketing_tasks(account_id, status);
CREATE INDEX IF NOT EXISTS marketing_tasks_piece ON public.marketing_tasks(piece_id) WHERE piece_id IS NOT NULL;

DROP TRIGGER IF EXISTS marketing_tasks_updated ON public.marketing_tasks;
CREATE TRIGGER marketing_tasks_updated BEFORE UPDATE ON public.marketing_tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.marketing_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_tasks FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marketing_tasks TO authenticated;
DROP POLICY IF EXISTS marketing_tasks_select ON public.marketing_tasks;
CREATE POLICY marketing_tasks_select ON public.marketing_tasks FOR SELECT
  USING (public.marketing_role(account_id) IS NOT NULL);
DROP POLICY IF EXISTS marketing_tasks_insert ON public.marketing_tasks;
CREATE POLICY marketing_tasks_insert ON public.marketing_tasks FOR INSERT
  WITH CHECK (public.marketing_role(account_id) IS NOT NULL);
DROP POLICY IF EXISTS marketing_tasks_update ON public.marketing_tasks;
CREATE POLICY marketing_tasks_update ON public.marketing_tasks FOR UPDATE
  USING (public.marketing_role(account_id) IS NOT NULL)
  WITH CHECK (public.marketing_role(account_id) IS NOT NULL);
DROP POLICY IF EXISTS marketing_tasks_delete ON public.marketing_tasks;
CREATE POLICY marketing_tasks_delete ON public.marketing_tasks FOR DELETE
  USING (public.marketing_role(account_id) = 'jefe'
         OR (public.marketing_role(account_id) IS NOT NULL AND created_by = auth.uid()));

-- Cada pieza nueva crea su tarea; al publicarse, la tarea pasa a 'listo'.
CREATE OR REPLACE FUNCTION public.marketing_piece_task() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.marketing_tasks (account_id, title, kind, assignee, due_on, piece_id, created_by)
    VALUES (NEW.account_id, NEW.title, 'pieza', NEW.assignee, NEW.scheduled_on, NEW.id, NEW.created_by);
  ELSIF NEW.status = 'publicada' AND OLD.status IS DISTINCT FROM 'publicada' THEN
    UPDATE public.marketing_tasks SET status = 'listo' WHERE piece_id = NEW.id AND status <> 'listo';
  END IF;
  RETURN NULL;
END;
$$;
ALTER FUNCTION public.marketing_piece_task() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.marketing_piece_task() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS marketing_pieces_task_ins ON public.marketing_pieces;
CREATE TRIGGER marketing_pieces_task_ins AFTER INSERT ON public.marketing_pieces
  FOR EACH ROW EXECUTE FUNCTION public.marketing_piece_task();
DROP TRIGGER IF EXISTS marketing_pieces_task_upd ON public.marketing_pieces;
CREATE TRIGGER marketing_pieces_task_upd AFTER UPDATE OF status ON public.marketing_pieces
  FOR EACH ROW EXECUTE FUNCTION public.marketing_piece_task();

-- ------------------------------------------------------------
-- 5. Storage: bucket privado 'marketing'
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('marketing', 'marketing', false, 52428800, ARRAY['image/*', 'video/*'])
ON CONFLICT (id) DO NOTHING;

-- Ruta {account_id}/{piece_id}/{archivo}: el primer tramo es la cuenta.
DROP POLICY IF EXISTS marketing_storage_select ON storage.objects;
CREATE POLICY marketing_storage_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'marketing' AND CASE
    WHEN (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN public.marketing_role(((storage.foldername(name))[1])::uuid) IS NOT NULL ELSE false END);
DROP POLICY IF EXISTS marketing_storage_insert ON storage.objects;
CREATE POLICY marketing_storage_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'marketing' AND CASE
    WHEN (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN public.marketing_role(((storage.foldername(name))[1])::uuid) IS NOT NULL ELSE false END);
DROP POLICY IF EXISTS marketing_storage_delete ON storage.objects;
CREATE POLICY marketing_storage_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'marketing' AND CASE
    WHEN (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN public.marketing_role(((storage.foldername(name))[1])::uuid) IS NOT NULL ELSE false END);

-- ------------------------------------------------------------
-- 6. Resumen y leads (solo el jefe)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.marketing_summary(p_month date DEFAULT NULL, p_project uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_mes date := date_trunc('month', COALESCE(p_month, (now() AT TIME ZONE 'America/Lima')::date))::date;
  v_next date;
  v_leads bigint;
  v_sep bigint;
  v_spend bigint;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR public.marketing_role(a) IS DISTINCT FROM 'jefe' THEN
    RAISE EXCEPTION 'Solo el jefe de marketing' USING ERRCODE = '42501'; END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.real_estate_projects WHERE id = p_project AND account_id = a) THEN
    RAISE EXCEPTION 'Proyecto no válido' USING ERRCODE = '22023'; END IF;
  v_next := (v_mes + interval '1 month')::date;

  SELECT count(*) INTO v_leads FROM public.contacts c
   WHERE c.account_id = a AND (c.created_at AT TIME ZONE 'America/Lima')::date >= v_mes
     AND (c.created_at AT TIME ZONE 'America/Lima')::date < v_next;

  SELECT count(*) INTO v_sep FROM public.reservations r
    JOIN public.contacts c ON c.id = r.contact_id
   WHERE r.account_id = a AND c.account_id = a AND r.status <> 'rechazada'
     AND (c.created_at AT TIME ZONE 'America/Lima')::date >= v_mes
     AND (c.created_at AT TIME ZONE 'America/Lima')::date < v_next
     AND (p_project IS NULL OR EXISTS (
           SELECT 1 FROM public.reservation_units ru JOIN public.real_estate_units u ON u.id = ru.unit_id
            WHERE ru.reservation_id = r.id AND u.project_id = p_project));

  -- Solo la caja principal de la cuenta (id = cuenta, migración 065): las cajas
  -- de otros negocios del dueño no cuentan como gasto de marketing de Golden.
  SELECT COALESCE(sum(e.amount_cents), 0) INTO v_spend FROM public.cash_entries e
   WHERE e.account_id = a AND e.company_id = a
     AND e.kind = 'expense' AND e.reversal_of IS NULL AND e.rubro = 'marketing'
     AND NOT EXISTS (SELECT 1 FROM public.cash_entries x WHERE x.reversal_of = e.id)
     AND to_jsonb(e)->>'transfer_id' IS NULL
     AND e.occurred_on >= v_mes AND e.occurred_on < v_next
     AND (p_project IS NULL OR e.project_id = p_project);

  RETURN jsonb_build_object(
    'month', to_char(v_mes, 'YYYY-MM'),
    'projectId', p_project,
    'projects', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name) ORDER BY r.name)
        FROM public.real_estate_projects r WHERE r.account_id = a), '[]'::jsonb),
    'leadsTotal', v_leads,
    'leadsByChannel', COALESCE((SELECT jsonb_agg(jsonb_build_object('channel', t.channel, 'count', t.n) ORDER BY t.n DESC, t.channel)
        FROM (SELECT COALESCE(NULLIF(btrim(c.lead_source), ''), 'sin_origen') AS channel, count(*) AS n
                FROM public.contacts c
               WHERE c.account_id = a AND (c.created_at AT TIME ZONE 'America/Lima')::date >= v_mes
                 AND (c.created_at AT TIME ZONE 'America/Lima')::date < v_next
               GROUP BY 1) t), '[]'::jsonb),
    'separaciones', v_sep,
    'spendCents', v_spend,
    'costPerLeadCents', CASE WHEN v_leads > 0 THEN round(v_spend::numeric / v_leads)::bigint END,
    'costPerSeparacionCents', CASE WHEN v_sep > 0 THEN round(v_spend::numeric / v_sep)::bigint END,
    'byMonth', (SELECT jsonb_agg(jsonb_build_object('month', to_char(m.d, 'YYYY-MM'),
          'leads', (SELECT count(*) FROM public.contacts c
                     WHERE c.account_id = a AND (c.created_at AT TIME ZONE 'America/Lima')::date >= m.d
                       AND (c.created_at AT TIME ZONE 'America/Lima')::date < (m.d + interval '1 month')::date),
          'spendCents', (SELECT COALESCE(sum(e.amount_cents), 0) FROM public.cash_entries e
                          WHERE e.account_id = a AND e.company_id = a
                            AND e.kind = 'expense' AND e.reversal_of IS NULL AND e.rubro = 'marketing'
                            AND NOT EXISTS (SELECT 1 FROM public.cash_entries x WHERE x.reversal_of = e.id)
                            AND to_jsonb(e)->>'transfer_id' IS NULL
                            AND e.occurred_on >= m.d AND e.occurred_on < (m.d + interval '1 month')::date
                            AND (p_project IS NULL OR e.project_id = p_project))
        ) ORDER BY m.d)
        FROM (SELECT (v_mes - make_interval(months => n))::date AS d FROM generate_series(0, 11) n) m),
    'broadcasts', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', b.name, 'sentAt', b.sent_at,
          'total', b.total_recipients, 'read', b.read_count, 'replied', b.replied_count) ORDER BY b.sent_at DESC)
        FROM (SELECT name, COALESCE(scheduled_at, created_at) AS sent_at, total_recipients, read_count, replied_count
                FROM public.broadcasts
               WHERE account_id = a AND status IN ('sending', 'sent')
               ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT 5) b), '[]'::jsonb));
END;
$$;
ALTER FUNCTION public.marketing_summary(date, uuid) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.marketing_leads(p_month date DEFAULT NULL, p_project uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a uuid;
  v_from date := CASE WHEN p_month IS NULL THEN NULL ELSE date_trunc('month', p_month)::date END;
  v_to date := CASE WHEN p_month IS NULL THEN NULL ELSE (date_trunc('month', p_month) + interval '1 month')::date END;
BEGIN
  SELECT account_id INTO a FROM public.profiles WHERE user_id = auth.uid();
  IF a IS NULL OR public.marketing_role(a) IS DISTINCT FROM 'jefe' THEN
    RAISE EXCEPTION 'Solo el jefe de marketing' USING ERRCODE = '42501'; END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'id', l.id, 'createdAt', l.created_at, 'name', l.name, 'phone', l.phone,
             'channel', l.channel, 'campaign', l.campaign_name, 'adId', l.ad_id, 'utmCampaign', l.utm_campaign,
             'projectId', l.project_id, 'projectName', l.project_name, 'advisorName', l.advisor_name,
             'separated', l.separated) ORDER BY l.created_at DESC)
      FROM (
        SELECT c.id, c.created_at, c.name, c.phone,
               COALESCE(NULLIF(btrim(c.lead_source), ''), 'sin_origen') AS channel,
               c.campaign_name, c.ad_id, c.utm_campaign,
               pr.project_id, pr.project_name,
               (SELECT COALESCE(NULLIF(p.full_name, ''), p.email) FROM public.conversations v
                  JOIN public.profiles p ON p.user_id = v.assigned_agent_id AND p.account_id = a
                 WHERE v.contact_id = c.id AND v.assigned_agent_id IS NOT NULL
                 ORDER BY v.created_at DESC LIMIT 1) AS advisor_name,
               EXISTS (SELECT 1 FROM public.reservations r
                        WHERE r.contact_id = c.id AND r.account_id = a AND r.status <> 'rechazada') AS separated
          FROM public.contacts c
          LEFT JOIN LATERAL (
            SELECT u.project_id, rp.name AS project_name
              FROM public.reservations r
              JOIN public.reservation_units ru ON ru.reservation_id = r.id
              JOIN public.real_estate_units u ON u.id = ru.unit_id
              LEFT JOIN public.real_estate_projects rp ON rp.id = u.project_id
             WHERE r.contact_id = c.id AND r.account_id = a AND r.status <> 'rechazada'
             ORDER BY r.created_at, ru.created_at LIMIT 1) pr ON true
         WHERE c.account_id = a
           AND (v_from IS NULL OR ((c.created_at AT TIME ZONE 'America/Lima')::date >= v_from
                                   AND (c.created_at AT TIME ZONE 'America/Lima')::date < v_to))
           AND (p_project IS NULL OR pr.project_id = p_project)
         ORDER BY c.created_at DESC
         LIMIT 500) l), '[]'::jsonb);
END;
$$;
ALTER FUNCTION public.marketing_leads(date, uuid) OWNER TO postgres;

-- ------------------------------------------------------------
-- Permisos de las funciones (solo usuarios con sesión)
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.marketing_role_of(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.marketing_role(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.marketing_my_access() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.marketing_review_piece(uuid, boolean, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.marketing_summary(date, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.marketing_leads(date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketing_role(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.marketing_my_access() TO authenticated;
GRANT EXECUTE ON FUNCTION public.marketing_review_piece(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.marketing_summary(date, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.marketing_leads(date, uuid) TO authenticated;

COMMIT;
