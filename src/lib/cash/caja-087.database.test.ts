import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// PostgreSQL desechable en memoria (sin credenciales ni BD real). Mismos
// stubs que postventa-086.database.test.ts; aplica 043-085 (más la agenda,
// 049) y la caja (063-065), luego 087 dos veces y corre
// supabase/tests/087_casos.sql, el mismo script que el dueño corre en
// producción tras aplicar la migración.
//
// La base real también tiene 069-074 (dueños de caja, detalles de
// movimiento, pases entre cajas), que viven en el repo GOLDEN CAJA y no en
// este. Aquí no se cargan: la 087 solo depende de 063-065, 084 y, para
// WhatsApp, de cash_is_owner() (075), que se sustituye por una versión mínima.
const db = new PGlite();
const sql = (name: string) => readFileSync(`supabase/migrations/${name}.sql`, "utf8");

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
      status text NOT NULL DEFAULT 'active', viewers_are_clients boolean NOT NULL DEFAULT false);
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
    "063_golden_caja",
    "064_cash_private_boxes_audit",
    "065_cash_companies",
  ]) {
    await db.exec(sql(m));
  }
  // La 075 se aplica en producción sobre 069-074; aquí solo hace falta saber quién es dueño de caja.
  await db.exec(`
    CREATE FUNCTION public.cash_is_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
      SELECT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND account_role = 'owner')
    $$;
  `);
  await db.exec(sql("087_caja_proyecto_rubro"));
  await db.exec(sql("087_caja_proyecto_rubro"));
}, 90000);

afterAll(() => db.close());

describe.sequential("087: caja con proyecto y rubro", () => {
  it("pasa todos los casos de supabase/tests/087_casos.sql", async () => {
    const results = await db.exec(readFileSync("supabase/tests/087_casos.sql", "utf8"));
    const ok = results.some((r) => r.rows.some((row) => (row as { resultado?: string }).resultado === "087: todos los casos OK"));
    expect(ok).toBe(true);
    // El script termina en ROLLBACK: no deja datos.
    const left = await db.query("SELECT 1 FROM auth.users WHERE email LIKE 't087-%'");
    expect(left.rows).toHaveLength(0);
  });

  it("la migración se puede aplicar otra vez sin romper nada", async () => {
    await db.exec(sql("087_caja_proyecto_rubro"));
    const cols = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'cash_entries' AND column_name IN ('project_id','project_general','rubro') ORDER BY 1",
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(["project_general", "project_id", "rubro"]);
  });

  it("sin sesión (anon) no se llega al panel", async () => {
    await db.exec("SET ROLE anon");
    await expect(db.query("SELECT public.cash_management_panel(NULL, NULL)")).rejects.toThrow();
    await db.exec("RESET ROLE");
  });
});
