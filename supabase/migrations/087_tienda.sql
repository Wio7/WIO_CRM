-- ============================================================
-- 087_tienda.sql — Tienda (módulo de pedidos de una tienda web externa)
--
-- Una tienda web (otra app, en su propio servidor) llama a la API pública
-- del CRM con una API key de la cuenta (scopes store:read / store:write):
-- lee el catálogo y crea pedidos. El personal de la cuenta ve y atiende los
-- pedidos en el panel /store.
--
-- Qué cambia:
--   1. store_settings: una fila por cuenta (WhatsApp, Yape, Mercado Pago,
--      nota de envíos, moneda, prefijo del código de pedido).
--   2. store_products: catálogo de la cuenta.
--   3. store_orders: pedidos. Los items guardan una COPIA (nombre y precio al
--      momento de comprar). El código (VL-0001) es correlativo por cuenta.
--   4. store_create_order(p_account_id, payload): crea el pedido. Solo la
--      llama el servidor (service_role). El total SIEMPRE sale de los
--      precios de la base y solo de productos activos de esa cuenta.
--   5. account_module_members acepta el módulo 'tienda' y my_module_access()
--      lo devuelve (para el menú).
--
-- Acceso: leen todos los miembros de la cuenta. Escriben el dueño / super
-- admin / gerencia o quien tenga el módulo 'tienda' (store_has_access).
-- Los usuarios no crean pedidos ni cambian los items o el total: solo el
-- estado y las notas del pedido.
--
-- Idempotente — se puede volver a correr.
-- Requiere: 084_pagos_protegidos.sql y 086_postventa.sql aplicadas.
-- ============================================================
BEGIN;

-- ============================================================
-- 1. Ajustes de la tienda
-- ============================================================
CREATE TABLE IF NOT EXISTS public.store_settings (
  account_id         uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled            boolean NOT NULL DEFAULT true,
  whatsapp           text,
  yape_number        text,
  yape_holder        text,
  mercadopago_holder text,
  mercadopago_link   text,
  shipping_note      text,
  currency           text NOT NULL DEFAULT 'PEN',
  -- Prefijo del código de pedido (VL-0001).
  order_prefix       text NOT NULL DEFAULT 'VL' CHECK (order_prefix ~ '^[A-Z]{1,6}$'),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- 2. Productos
-- ============================================================
CREATE TABLE IF NOT EXISTS public.store_products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(trim(name)) > 0),
  subtitle    text,
  description text,
  price       numeric(12,2) NOT NULL CHECK (price >= 0),
  currency    text NOT NULL DEFAULT 'PEN',
  image_url   text,
  includes    text[] NOT NULL DEFAULT '{}',
  badge       text,
  active      boolean NOT NULL DEFAULT true,
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_store_products_account
  ON public.store_products(account_id, active, sort);

-- ============================================================
-- 3. Pedidos
-- ============================================================
CREATE TABLE IF NOT EXISTS public.store_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Número correlativo por cuenta y su código legible (VL-0001).
  seq               integer NOT NULL,
  code              text NOT NULL,
  customer_name     text NOT NULL,
  customer_phone    text NOT NULL,
  customer_email    text,
  customer_document text,
  shipping_method   text NOT NULL
                      CHECK (shipping_method IN ('shalom', 'olva', 'marvisur', 'internacional', 'recojo')),
  country           text NOT NULL DEFAULT 'Peru',
  city              text NOT NULL,
  address           text NOT NULL,
  payment_method    text NOT NULL CHECK (payment_method IN ('yape', 'mercadopago', 'whatsapp')),
  status            text NOT NULL DEFAULT 'nuevo'
                      CHECK (status IN ('nuevo', 'pagado', 'enviado', 'entregado', 'cancelado')),
  -- Copia al momento de comprar: product_id, name, unit_price, quantity, subtotal.
  items             jsonb NOT NULL,
  total             numeric(12,2) NOT NULL CHECK (total >= 0),
  currency          text NOT NULL DEFAULT 'PEN',
  notes             text,
  source            text CHECK (source IS NULL OR source IN ('tiktok', 'instagram', 'facebook', 'link')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, seq),
  UNIQUE (account_id, code)
);

CREATE INDEX IF NOT EXISTS idx_store_orders_account
  ON public.store_orders(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_orders_status
  ON public.store_orders(account_id, status, created_at DESC);

DROP TRIGGER IF EXISTS store_settings_updated_at ON public.store_settings;
CREATE TRIGGER store_settings_updated_at
  BEFORE UPDATE ON public.store_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS store_products_updated_at ON public.store_products;
CREATE TRIGGER store_products_updated_at
  BEFORE UPDATE ON public.store_products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS store_orders_updated_at ON public.store_orders;
CREATE TRIGGER store_orders_updated_at
  BEFORE UPDATE ON public.store_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 4. Acceso y RLS
-- ============================================================
-- Módulo 'tienda' explícito, dueño / super admin, o área gerencia.
CREATE OR REPLACE FUNCTION public.store_has_access(p_account_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.can_access_module(p_account_id, 'tienda')
      OR public.is_owner_or_gerencia(p_account_id);
$$;
ALTER FUNCTION public.store_has_access(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.store_has_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_has_access(uuid) TO anon, authenticated, service_role;

-- 'tienda' como módulo asignable por persona.
ALTER TABLE public.account_module_members DROP CONSTRAINT IF EXISTS account_module_members_module_key_check;
ALTER TABLE public.account_module_members
  ADD CONSTRAINT account_module_members_module_key_check
  CHECK (module_key IN ('cobranzas', 'legal', 'cronograma', 'ventas', 'postventa', 'tienda'));

ALTER TABLE public.store_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_orders   ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.store_settings, public.store_products, public.store_orders FROM anon;
REVOKE ALL ON public.store_settings, public.store_products, public.store_orders FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_products TO authenticated;
-- Pedidos: se leen; solo se puede cambiar el estado y las notas.
GRANT SELECT ON public.store_orders TO authenticated;
GRANT UPDATE (status, notes) ON public.store_orders TO authenticated;

DROP POLICY IF EXISTS store_settings_select ON public.store_settings;
CREATE POLICY store_settings_select ON public.store_settings FOR SELECT
  USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS store_settings_insert ON public.store_settings;
CREATE POLICY store_settings_insert ON public.store_settings FOR INSERT
  WITH CHECK (public.store_has_access(account_id));
DROP POLICY IF EXISTS store_settings_update ON public.store_settings;
CREATE POLICY store_settings_update ON public.store_settings FOR UPDATE
  USING (public.store_has_access(account_id)) WITH CHECK (public.store_has_access(account_id));
DROP POLICY IF EXISTS store_settings_delete ON public.store_settings;
CREATE POLICY store_settings_delete ON public.store_settings FOR DELETE
  USING (public.store_has_access(account_id));

DROP POLICY IF EXISTS store_products_select ON public.store_products;
CREATE POLICY store_products_select ON public.store_products FOR SELECT
  USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS store_products_insert ON public.store_products;
CREATE POLICY store_products_insert ON public.store_products FOR INSERT
  WITH CHECK (public.store_has_access(account_id));
DROP POLICY IF EXISTS store_products_update ON public.store_products;
CREATE POLICY store_products_update ON public.store_products FOR UPDATE
  USING (public.store_has_access(account_id)) WITH CHECK (public.store_has_access(account_id));
DROP POLICY IF EXISTS store_products_delete ON public.store_products;
CREATE POLICY store_products_delete ON public.store_products FOR DELETE
  USING (public.store_has_access(account_id));

DROP POLICY IF EXISTS store_orders_select ON public.store_orders;
CREATE POLICY store_orders_select ON public.store_orders FOR SELECT
  USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS store_orders_update ON public.store_orders;
CREATE POLICY store_orders_update ON public.store_orders FOR UPDATE
  USING (public.store_has_access(account_id)) WITH CHECK (public.store_has_access(account_id));

-- ============================================================
-- 5. store_create_order — la llama el servidor de la API pública
--    payload: { customer:{name,phone,email,document},
--               shipping:{method,country,city,address},
--               payment_method, items:[{product_id,quantity}], notes, source }
--    Precios, nombres y total salen de store_products, nunca del payload.
--    Devuelve { id, code, total, currency, status, items }.
-- ============================================================
CREATE OR REPLACE FUNCTION public.store_create_order(p_account_id uuid, payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settings  store_settings%ROWTYPE;
  v_name      text := NULLIF(trim(payload #>> '{customer,name}'), '');
  v_phone     text := NULLIF(trim(payload #>> '{customer,phone}'), '');
  v_method    text := payload #>> '{shipping,method}';
  v_city      text := NULLIF(trim(payload #>> '{shipping,city}'), '');
  v_address   text := NULLIF(trim(payload #>> '{shipping,address}'), '');
  v_country   text := COALESCE(NULLIF(trim(payload #>> '{shipping,country}'), ''), 'Peru');
  v_payment   text := payload ->> 'payment_method';
  v_source    text := NULLIF(payload ->> 'source', '');
  v_requested integer;
  v_found     integer;
  v_bad_qty   integer;
  v_currencies integer;
  v_currency  text;
  v_total     numeric(12,2);
  v_items     jsonb;
  v_seq       integer;
  v_code      text;
  v_id        uuid;
BEGIN
  IF p_account_id IS NULL OR payload IS NULL OR jsonb_typeof(payload) <> 'object' THEN
    RAISE EXCEPTION 'Pedido invalido' USING ERRCODE = '22023';
  END IF;

  -- Se bloquea la fila de ajustes: dos pedidos a la vez no repiten número.
  SELECT * INTO v_settings FROM store_settings WHERE account_id = p_account_id FOR UPDATE;
  IF NOT FOUND OR NOT v_settings.enabled THEN
    RAISE EXCEPTION 'La tienda no esta disponible' USING ERRCODE = '55000';
  END IF;

  IF v_name IS NULL THEN RAISE EXCEPTION 'Falta el nombre del cliente' USING ERRCODE = '22023'; END IF;
  IF v_phone IS NULL THEN RAISE EXCEPTION 'Falta el telefono del cliente' USING ERRCODE = '22023'; END IF;
  IF v_method IS NULL OR v_method NOT IN ('shalom', 'olva', 'marvisur', 'internacional', 'recojo') THEN
    RAISE EXCEPTION 'Metodo de envio invalido' USING ERRCODE = '22023';
  END IF;
  IF v_city IS NULL THEN RAISE EXCEPTION 'Falta la ciudad de envio' USING ERRCODE = '22023'; END IF;
  IF v_address IS NULL THEN RAISE EXCEPTION 'Falta la direccion de envio' USING ERRCODE = '22023'; END IF;
  IF v_payment IS NULL OR v_payment NOT IN ('yape', 'mercadopago', 'whatsapp') THEN
    RAISE EXCEPTION 'Metodo de pago invalido' USING ERRCODE = '22023';
  END IF;
  IF v_source IS NOT NULL AND v_source NOT IN ('tiktok', 'instagram', 'facebook', 'link') THEN
    RAISE EXCEPTION 'Origen invalido' USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(payload -> 'items') IS DISTINCT FROM 'array' OR jsonb_array_length(payload -> 'items') = 0 THEN
    RAISE EXCEPTION 'Agrega al menos un producto' USING ERRCODE = '22023';
  END IF;

  BEGIN
    -- Un renglón por producto (repetidos se suman), en el orden pedido.
    WITH req AS (
      SELECT (e ->> 'product_id')::uuid AS pid,
             sum((e ->> 'quantity')::integer) AS qty,
             min(n) AS ord
        FROM jsonb_array_elements(payload -> 'items') WITH ORDINALITY AS t(e, n)
       GROUP BY 1
    ), joined AS (
      SELECT r.pid, r.qty, r.ord, p.id AS found_id, p.name, p.price, p.currency
        FROM req r
        LEFT JOIN store_products p
               ON p.id = r.pid AND p.account_id = p_account_id AND p.active
    )
    SELECT count(*)::integer,
           count(found_id)::integer,
           count(*) FILTER (WHERE qty < 1 OR qty > 20)::integer,
           count(DISTINCT currency)::integer,
           min(currency),
           COALESCE(sum(price * qty), 0)::numeric(12,2),
           jsonb_agg(jsonb_build_object(
             'product_id', pid, 'name', name, 'unit_price', price,
             'quantity', qty, 'subtotal', (price * qty)::numeric(12,2)) ORDER BY ord)
      INTO v_requested, v_found, v_bad_qty, v_currencies, v_currency, v_total, v_items
      FROM joined;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_parameter_value THEN
    RAISE EXCEPTION 'Los productos o cantidades no son validos' USING ERRCODE = '22023';
  END;

  IF v_bad_qty > 0 THEN
    RAISE EXCEPTION 'La cantidad de cada producto debe ser de 1 a 20' USING ERRCODE = '22023';
  END IF;
  IF v_found < v_requested THEN
    RAISE EXCEPTION 'Uno de los productos no esta disponible' USING ERRCODE = '22023';
  END IF;
  IF v_currencies > 1 THEN
    RAISE EXCEPTION 'Los productos tienen monedas distintas' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(max(seq), 0) + 1 INTO v_seq FROM store_orders WHERE account_id = p_account_id;
  v_code := v_settings.order_prefix || '-' || lpad(v_seq::text, 4, '0');

  INSERT INTO store_orders (
    account_id, seq, code, customer_name, customer_phone, customer_email, customer_document,
    shipping_method, country, city, address, payment_method, items, total, currency, notes, source)
  VALUES (
    p_account_id, v_seq, v_code, v_name, v_phone,
    NULLIF(trim(payload #>> '{customer,email}'), ''), NULLIF(trim(payload #>> '{customer,document}'), ''),
    v_method, v_country, v_city, v_address, v_payment, v_items, v_total, v_currency,
    NULLIF(trim(payload ->> 'notes'), ''), v_source)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'code', v_code, 'total', v_total,
                            'currency', v_currency, 'status', 'nuevo', 'items', v_items);
END;
$$;

ALTER FUNCTION public.store_create_order(uuid, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.store_create_order(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_create_order(uuid, jsonb) TO service_role;

-- ============================================================
-- 6. my_module_access suma 'tienda' (lo de 086 + una llave)
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
              'tienda',     public.store_has_access(p.account_id),
              'gerencia',   public.is_owner_or_gerencia(p.account_id))
       FROM public.profiles p WHERE p.user_id = auth.uid()),
    jsonb_build_object('cobranzas', false, 'legal', false, 'cronograma', false,
                       'ventas', false, 'postventa', false, 'tienda', false, 'gerencia', false));
$$;
ALTER FUNCTION public.my_module_access() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.my_module_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_module_access() TO authenticated;

-- La Tienda es opcional: las cuentas que ya existían antes de este módulo
-- la tienen apagada (sus dueños y gerentes no deben ver un menú nuevo).
-- El corte por fecha evita volver a apagarla en cuentas nuevas si se
-- corre de nuevo. Para encenderla en una cuenta: quitar '/store' de
-- accounts.disabled_modules (el seed de la tienda lo hace).
UPDATE public.accounts
   SET disabled_modules = array_append(disabled_modules, '/store')
 WHERE created_at < TIMESTAMPTZ '2026-11-11 00:00:00-05'
   AND NOT ('/store' = ANY (disabled_modules));

COMMENT ON TABLE public.store_orders IS
  'Pedidos de la Tienda. Se crean solo con store_create_order (service_role, API pública); el personal cambia estado y notas.';

COMMIT;

-- PostgREST lee el esquema nuevo sin reiniciar.
NOTIFY pgrst, 'reload schema';
