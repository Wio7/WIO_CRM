import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// PostgreSQL desechable en memoria. Mismos stubs que
// postventa-086.database.test.ts; aplica 043-086 y luego 087 dos veces
// (idempotente). Prueba store_create_order (el total sale de la base) y
// las politicas RLS de la Tienda.
const db = new PGlite();
const sql = (name: string) => readFileSync(`supabase/migrations/${name}.sql`, "utf8");

const A = "a0870000-0000-4000-8000-00000000000a";
const B = "b0870000-0000-4000-8000-00000000000b";
const OWNER_A = "a0870000-0000-4000-8000-000000000001";
const AGENT_A = "a0870000-0000-4000-8000-000000000002";
const TIENDA_A = "a0870000-0000-4000-8000-000000000003";
const OWNER_B = "b0870000-0000-4000-8000-000000000001";
const PROD_A1 = "a0870000-0000-4000-8000-0000000000a1";
const PROD_A2 = "a0870000-0000-4000-8000-0000000000a2";
const PROD_OFF = "a0870000-0000-4000-8000-0000000000a3";
const PROD_B1 = "b0870000-0000-4000-8000-0000000000b1";
const OLD = "c0870000-0000-4000-8000-00000000000c";

const input = (items: object[], extra: object = {}) =>
  JSON.stringify({
    customer: { name: "Ana", phone: "999111222", email: null, document: null },
    shipping: { method: "shalom", country: "Peru", city: "Ica", address: "Av. Grau 1" },
    payment_method: "yape",
    items,
    notes: null,
    source: "tiktok",
    ...extra,
  });

async function createOrder(account: string, payload: string) {
  const r = await db.query<{ o: unknown }>("SELECT public.store_create_order($1::uuid, $2::jsonb) AS o", [
    account,
    payload,
  ]);
  return r.rows[0].o as {
    id: string;
    code: string;
    total: number;
    currency: string;
    status: string;
    items: { product_id: string; name: string; unit_price: number; quantity: number; subtotal: number }[];
  };
}

async function asUser(uid: string, fn: () => Promise<void>) {
  await db.exec(`SELECT set_config('request.jwt.claim.sub', '${uid}', false); SET ROLE authenticated;`);
  try {
    await fn();
  } finally {
    await db.exec("RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);");
  }
}

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, instance_id uuid, aud text, role text, email text,
      raw_user_meta_data jsonb, created_at timestamptz, updated_at timestamptz);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;
    GRANT SELECT ON auth.users TO authenticated;
    CREATE TYPE account_role_enum AS ENUM ('owner', 'admin', 'agent', 'viewer');
    CREATE FUNCTION update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
    CREATE TABLE accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text,
      owner_user_id uuid REFERENCES auth.users,
      status text NOT NULL DEFAULT 'active', viewers_are_clients boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      disabled_modules text[] NOT NULL DEFAULT ARRAY[]::text[]);
    CREATE TABLE profiles(id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      user_id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
      account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
      account_role account_role_enum NOT NULL, full_name text, email text,
      created_at timestamptz DEFAULT now(),
      area text, area_set_by uuid REFERENCES profiles(id) ON DELETE SET NULL, area_set_at timestamptz);
    CREATE TABLE contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE, user_id uuid, phone text, name text);
    CREATE TABLE conversations(id uuid PRIMARY KEY, account_id uuid REFERENCES accounts ON DELETE CASCADE,
      contact_id uuid, assigned_agent_id uuid);
    CREATE TABLE real_estate_projects(id uuid PRIMARY KEY, account_id uuid REFERENCES accounts ON DELETE CASCADE,
      name text);
    CREATE TABLE real_estate_units(id uuid PRIMARY KEY, account_id uuid REFERENCES accounts ON DELETE CASCADE,
      project_id uuid REFERENCES real_estate_projects ON DELETE CASCADE, code text, manzana text);
    CREATE TABLE reservations(id uuid PRIMARY KEY, account_id uuid REFERENCES accounts ON DELETE CASCADE);
    CREATE TABLE reservation_payments(id uuid PRIMARY KEY, account_id uuid REFERENCES accounts ON DELETE CASCADE);
    CREATE TABLE platform_admins(user_id uuid PRIMARY KEY);
    CREATE TABLE legal_members(account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE, role text NOT NULL,
      PRIMARY KEY (account_id, user_id));
    CREATE FUNCTION public.is_super_admin() RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = public
      AS $$ SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid()); $$;
    CREATE FUNCTION public.is_account_member(target_account_id UUID, min_role account_role_enum DEFAULT 'viewer')
    RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.profiles p JOIN public.accounts a ON a.id = p.account_id
        WHERE p.user_id = auth.uid() AND p.account_id = target_account_id
          AND (a.status = 'active' OR public.is_super_admin())
          AND NOT (p.account_role = 'viewer' AND a.viewers_are_clients)
          AND CASE p.account_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END
           >= CASE min_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END);
    $$;
    ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY profiles_select ON profiles FOR SELECT USING (user_id = auth.uid());
    CREATE POLICY profiles_update ON profiles FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
    ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
  `);
  for (const m of [
    "043_payment_plans",
    "047_installment_payment_detail",
    "049_agenda",
    "052_recordatorios_cuotas",
    "082_gestiones_cobranza",
    "083_mora_y_abonos",
    "084_pagos_protegidos",
    "085_conexiones",
    "086_postventa",
  ]) {
    await db.exec(sql(m));
  }
  // Cuenta anterior al módulo: la 087 le apaga la Tienda (una sola vez).
  await db.exec(`INSERT INTO accounts (id, name, created_at, disabled_modules)
    VALUES ('${OLD}', 'Antigua', '2026-01-01', ARRAY['/coupons']);`);
  await db.exec(sql("087_tienda"));
  await db.exec(sql("087_tienda"));

  await db.exec(`
    INSERT INTO auth.users (id) VALUES ('${OWNER_A}'), ('${AGENT_A}'), ('${TIENDA_A}'), ('${OWNER_B}');
    INSERT INTO accounts (id, name, owner_user_id) VALUES ('${A}', 'Cuenta A', '${OWNER_A}'), ('${B}', 'Cuenta B', '${OWNER_B}');
    INSERT INTO profiles (user_id, account_id, account_role, full_name) VALUES
      ('${OWNER_A}', '${A}', 'owner', 'Dueno A'),
      ('${AGENT_A}', '${A}', 'agent', 'Agente A'),
      ('${TIENDA_A}', '${A}', 'agent', 'Tienda A'),
      ('${OWNER_B}', '${B}', 'owner', 'Dueno B');
    INSERT INTO account_module_members (account_id, user_id, module_key) VALUES ('${A}', '${TIENDA_A}', 'tienda');
    INSERT INTO store_settings (account_id, whatsapp) VALUES ('${A}', '+51900000000'), ('${B}', '+51911111111');
    INSERT INTO store_products (id, account_id, name, price, active) VALUES
      ('${PROD_A1}', '${A}', 'Basico', 269, true),
      ('${PROD_A2}', '${A}', 'Intermedio', 529.50, true),
      ('${PROD_OFF}', '${A}', 'Agotado', 100, false),
      ('${PROD_B1}', '${B}', 'De B', 10, true);
  `);
}, 90000);

afterAll(() => db.close());

describe.sequential("087: tienda", () => {
  it("calcula el total con los precios de la base y deja una copia de los items", async () => {
    const o = await createOrder(A, input([{ product_id: PROD_A1, quantity: 2 }, { product_id: PROD_A2, quantity: 1 }]));
    expect(o.total).toBe(1067.5);
    expect(o.currency).toBe("PEN");
    expect(o.status).toBe("nuevo");
    expect(o.items).toEqual([
      { product_id: PROD_A1, name: "Basico", unit_price: 269, quantity: 2, subtotal: 538 },
      { product_id: PROD_A2, name: "Intermedio", unit_price: 529.5, quantity: 1, subtotal: 529.5 },
    ]);
  });

  it("ignora precios y totales que mande el cliente", async () => {
    const o = await createOrder(A, input([{ product_id: PROD_A1, quantity: 1, unit_price: 1, price: 1 }], { total: 1 }));
    expect(o.total).toBe(269);
  });

  it("numera los pedidos por cuenta: VL-0001, VL-0002... y cada cuenta empieza en 0001", async () => {
    const a = await db.query<{ code: string }>("SELECT code FROM store_orders WHERE account_id = $1 ORDER BY seq", [A]);
    expect(a.rows.map((r) => r.code)).toEqual(["VL-0001", "VL-0002"]);
    const b = await createOrder(B, input([{ product_id: PROD_B1, quantity: 3 }]));
    expect(b.code).toBe("VL-0001");
    expect(b.total).toBe(30);
  });

  it.each([
    ["producto inactivo", [{ product_id: PROD_OFF, quantity: 1 }]],
    ["producto de otra cuenta", [{ product_id: PROD_B1, quantity: 1 }]],
    ["producto inexistente", [{ product_id: "a0870000-0000-4000-8000-0000000000ff", quantity: 1 }]],
    ["cantidad 0", [{ product_id: PROD_A1, quantity: 0 }]],
    ["cantidad 21", [{ product_id: PROD_A1, quantity: 21 }]],
    ["sin items", []],
  ])("rechaza: %s", async (_n, items) => {
    await expect(createOrder(A, input(items))).rejects.toThrow();
    const n = await db.query<{ c: number }>("SELECT count(*)::int AS c FROM store_orders WHERE account_id = $1", [A]);
    expect(n.rows[0].c).toBe(2);
  });

  it("rechaza metodo de envio o de pago fuera de la lista", async () => {
    const items = [{ product_id: PROD_A1, quantity: 1 }];
    await expect(createOrder(A, input(items, { payment_method: "bitcoin" }))).rejects.toThrow();
    await expect(
      createOrder(A, input(items, { shipping: { method: "dhl", city: "Ica", address: "x" } })),
    ).rejects.toThrow();
  });

  it("rechaza si la tienda esta apagada", async () => {
    await db.exec(`UPDATE store_settings SET enabled = false WHERE account_id = '${A}'`);
    await expect(createOrder(A, input([{ product_id: PROD_A1, quantity: 1 }]))).rejects.toThrow(/no esta disponible/);
    await db.exec(`UPDATE store_settings SET enabled = true WHERE account_id = '${A}'`);
  });

  it("solo el servicio puede crear pedidos (no un usuario con sesion)", async () => {
    await asUser(OWNER_A, async () => {
      await expect(createOrder(A, input([{ product_id: PROD_A1, quantity: 1 }]))).rejects.toThrow(/permission denied/);
      await expect(
        db.exec(`INSERT INTO store_orders (account_id, code, seq, customer_name, customer_phone, shipping_method, city, address, payment_method, items, total)
                 VALUES ('${A}', 'X-1', 99, 'x', '1', 'olva', 'c', 'a', 'yape', '[]', 1)`),
      ).rejects.toThrow();
    });
  });

  it("RLS: los miembros leen los pedidos de su cuenta y de ninguna otra", async () => {
    await asUser(AGENT_A, async () => {
      const r = await db.query("SELECT 1 FROM store_orders");
      expect(r.rows).toHaveLength(2);
      const p = await db.query("SELECT 1 FROM store_products");
      expect(p.rows).toHaveLength(3);
    });
    await asUser(OWNER_B, async () => {
      const r = await db.query<{ account_id: string }>("SELECT account_id FROM store_orders");
      expect(r.rows.map((x) => x.account_id)).toEqual([B]);
    });
  });

  it("RLS: escribe el dueno o quien tiene el modulo tienda; un agente sin modulo no", async () => {
    await asUser(AGENT_A, async () => {
      const u = await db.query(`UPDATE store_orders SET status = 'pagado' WHERE account_id = '${A}' RETURNING 1`);
      expect(u.rows).toHaveLength(0);
      const p = await db.query(`UPDATE store_products SET name = 'x' WHERE account_id = '${A}' RETURNING 1`);
      expect(p.rows).toHaveLength(0);
      await expect(
        db.exec(`INSERT INTO store_products (account_id, name, price) VALUES ('${A}', 'Nuevo', 1)`),
      ).rejects.toThrow();
    });
    await asUser(TIENDA_A, async () => {
      const u = await db.query(`UPDATE store_orders SET status = 'pagado' WHERE account_id = '${A}' RETURNING 1`);
      expect(u.rows).toHaveLength(2);
      await db.exec(`INSERT INTO store_products (account_id, name, price) VALUES ('${A}', 'Nuevo', 1)`);
    });
    await asUser(OWNER_A, async () => {
      await db.exec(`UPDATE store_settings SET shipping_note = 'ok' WHERE account_id = '${A}'`);
      const s = await db.query<{ shipping_note: string }>("SELECT shipping_note FROM store_settings");
      expect(s.rows).toEqual([{ shipping_note: "ok" }]);
    });
  });

  it("RLS: nadie toca los datos de otra cuenta", async () => {
    await asUser(OWNER_B, async () => {
      const u = await db.query(`UPDATE store_orders SET status = 'cancelado' WHERE account_id = '${A}' RETURNING 1`);
      expect(u.rows).toHaveLength(0);
      await expect(
        db.exec(`INSERT INTO store_products (account_id, name, price) VALUES ('${A}', 'Colado', 1)`),
      ).rejects.toThrow();
    });
  });

  it("apaga la Tienda solo en cuentas anteriores al modulo, sin duplicarla", async () => {
    const r = await db.query<{ id: string; disabled_modules: string[] }>(
      `SELECT id, disabled_modules FROM accounts WHERE id IN ('${OLD}', '${A}') ORDER BY name`,
    );
    const byId = Object.fromEntries(r.rows.map((x) => [x.id, x.disabled_modules]));
    expect(byId[OLD]).toEqual(["/coupons", "/store"]);
    expect(byId[A]).toEqual([]);
  });

  it("my_module_access suma tienda", async () => {
    await asUser(TIENDA_A, async () => {
      const r = await db.query<{ m: Record<string, boolean> }>("SELECT public.my_module_access() AS m");
      expect(r.rows[0].m.tienda).toBe(true);
    });
    await asUser(AGENT_A, async () => {
      const r = await db.query<{ m: Record<string, boolean> }>("SELECT public.my_module_access() AS m");
      expect(r.rows[0].m.tienda).toBe(false);
    });
  });
});
