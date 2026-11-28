-- ============================================================
-- 300_dulmo_base.sql — Base de la App DULMO (taller de cocinas de melamina)
--
-- Pedido de Bryce (2026-11-28): DULMO (Moni Bahos, Ica) es una cuenta más de
-- la suite. Su app propia (repo Wio7/DULMO-APP) sirve para medir, diseñar en
-- 3D, sacar el despiece y la lista de cortes, y presupuestar. Solo la usa la
-- dueña. Serie 300+ para no chocar con el CRM (<200) ni con Tumi (200+).
--
-- SOLO AGREGA objetos nuevos. Crea:
--   1. dulmo_cuenta_habilitada(cuenta): la cuenta tiene 'App DULMO' en
--      accounts.apps (solo el super admin cambia apps, ver 081).
--   2. dulmo_my_access(): cuenta, marca y rol del usuario, o nada.
--   3. dulmo_ajustes   (una fila por cuenta, precios y datos del taller en jsonb).
--   4. dulmo_proyectos (cliente, estado, medidas, diseño, totales).
--   5. dulmo_mediciones (agenda de mediciones a domicilio).
--   6. Bucket privado 'dulmo' (fotos de la medición): {account_id}/{proyecto}/{archivo}.
--
-- Seguridad (ADR 2026-11-15): authenticated incluye a usuarios de TODAS las
-- cuentas; cada política exige is_account_member(account_id, 'agent') (cuenta
-- activa, sin viewer ni promueve, ver 089) Y que la cuenta tenga la app.
-- anon no tiene acceso a nada.
--
-- Casos: supabase/tests/300_casos.sql (correr después; termina en ROLLBACK).
-- Idempotente — se puede volver a correr.
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- 1. ¿La cuenta tiene la App DULMO?
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dulmo_cuenta_habilitada(p_account uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.accounts a
     WHERE a.id = p_account AND a.status = 'active' AND 'App DULMO' = ANY (a.apps)
  );
$$;
ALTER FUNCTION public.dulmo_cuenta_habilitada(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.dulmo_cuenta_habilitada(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dulmo_cuenta_habilitada(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.dulmo_puede(p_account uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_account IS NOT NULL
     AND public.is_account_member(p_account, 'agent')
     AND public.dulmo_cuenta_habilitada(p_account);
$$;
ALTER FUNCTION public.dulmo_puede(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.dulmo_puede(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dulmo_puede(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 2. Acceso de la sesión actual
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dulmo_my_access()
RETURNS TABLE (account_id uuid, brand_name text, logo_url text, account_role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, COALESCE(a.brand_name, a.name), a.logo_url, p.account_role::text
    FROM public.profiles p
    JOIN public.accounts a ON a.id = p.account_id
   WHERE p.user_id = auth.uid()
     AND public.dulmo_puede(a.id)
   LIMIT 1;
$$;
ALTER FUNCTION public.dulmo_my_access() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.dulmo_my_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dulmo_my_access() TO authenticated;

-- ------------------------------------------------------------
-- 3. Ajustes (precios y datos del taller)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dulmo_ajustes (
  account_id uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  datos      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- ------------------------------------------------------------
-- 4. Proyectos
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dulmo_proyectos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  cliente_nombre   text NOT NULL DEFAULT '',
  cliente_telefono text,
  distrito         text,
  direccion        text,
  nombre           text NOT NULL DEFAULT 'Cocina',
  estado           text NOT NULL DEFAULT 'medido'
                   CHECK (estado IN ('medido','cotizado','anticipo','corte','armado','instalado','pagado','perdido')),
  paredes          jsonb NOT NULL DEFAULT '[]'::jsonb,   -- medidas tomadas en obra
  diseno           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- muebles, colores, cubierta
  fotos            text[] NOT NULL DEFAULT ARRAY[]::text[],
  precio_cliente   numeric(12,2),
  costo_total      numeric(12,2),
  anticipo         numeric(12,2),
  notas            text,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dulmo_proyectos_cuenta_idx ON public.dulmo_proyectos (account_id, updated_at DESC);

-- ------------------------------------------------------------
-- 5. Mediciones (agenda)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dulmo_mediciones (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  proyecto_id      uuid REFERENCES public.dulmo_proyectos(id) ON DELETE SET NULL,
  cliente_nombre   text NOT NULL DEFAULT '',
  cliente_telefono text,
  distrito         text,
  direccion        text,
  fecha            timestamptz NOT NULL,
  estado           text NOT NULL DEFAULT 'pendiente'
                   CHECK (estado IN ('pendiente','hecha','cancelada','no_vino')),
  origen           text NOT NULL DEFAULT 'manual' CHECK (origen IN ('manual','whatsapp','web')),
  notas            text,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dulmo_mediciones_cuenta_fecha_idx ON public.dulmo_mediciones (account_id, fecha);

-- updated_at automático
CREATE OR REPLACE FUNCTION public.dulmo_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS dulmo_proyectos_touch ON public.dulmo_proyectos;
CREATE TRIGGER dulmo_proyectos_touch BEFORE UPDATE ON public.dulmo_proyectos
  FOR EACH ROW EXECUTE FUNCTION public.dulmo_touch();
DROP TRIGGER IF EXISTS dulmo_ajustes_touch ON public.dulmo_ajustes;
CREATE TRIGGER dulmo_ajustes_touch BEFORE UPDATE ON public.dulmo_ajustes
  FOR EACH ROW EXECUTE FUNCTION public.dulmo_touch();

-- ------------------------------------------------------------
-- RLS: las tres tablas, misma regla
-- ------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dulmo_ajustes','dulmo_proyectos','dulmo_mediciones'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_todo', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated
         USING (public.dulmo_puede(account_id))
         WITH CHECK (public.dulmo_puede(account_id))', t || '_todo', t);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 6. Storage: fotos de la medición
-- ------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('dulmo', 'dulmo', false, 15728640, ARRAY['image/jpeg','image/png','image/webp','image/heic'])
ON CONFLICT (id) DO NOTHING;

-- Valida el texto ANTES de convertirlo: un cast directo a uuid dentro de la
-- política podría fallar con rutas de otros buckets (Postgres no garantiza el
-- orden de evaluación del AND).
CREATE OR REPLACE FUNCTION public.dulmo_puede_ruta(p_bucket text, p_name text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE carpeta text;
BEGIN
  IF p_bucket IS DISTINCT FROM 'dulmo' THEN RETURN false; END IF;
  carpeta := split_part(p_name, '/', 1);
  IF carpeta !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN public.dulmo_puede(carpeta::uuid);
END;
$$;
ALTER FUNCTION public.dulmo_puede_ruta(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.dulmo_puede_ruta(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dulmo_puede_ruta(text, text) TO authenticated;

DROP POLICY IF EXISTS dulmo_fotos_todo ON storage.objects;
CREATE POLICY dulmo_fotos_todo ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'dulmo' AND public.dulmo_puede_ruta(bucket_id, name))
  WITH CHECK (bucket_id = 'dulmo' AND public.dulmo_puede_ruta(bucket_id, name));

COMMIT;
