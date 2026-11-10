import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// PostgreSQL desechable en memoria (sin credenciales ni BD real). Mismos
// stubs que handoffs-085.database.test.ts; aplica 043-085 (más la agenda,
// 049), luego 086 dos veces y corre supabase/tests/086_casos.sql, el mismo
// script que el dueño corre en producción tras aplicar la migración.
const db = new PGlite();
const sql = (name: string) => readFileSync(`supabase/migrations/${name}.sql`, "utf8");

const ALEJANDRO = "289a80e1-9d61-4e83-9b93-c91e1b843851";
const GOLDEN = "d74b5dfd-2999-4e2c-9a0e-10b3d540898b";

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
  ]) {
    await db.exec(sql(m));
  }
  await db.exec(sql("086_postventa"));
  await db.exec(sql("086_postventa"));
}, 60000);

afterAll(() => db.close());

describe.sequential("086: postventa", () => {
  it("pasa todos los casos de supabase/tests/086_casos.sql", async () => {
    const results = await db.exec(readFileSync("supabase/tests/086_casos.sql", "utf8"));
    const ok = results.some((r) => r.rows.some((row) => (row as { resultado?: string }).resultado === "086: todos los casos OK"));
    expect(ok).toBe(true);
    // El script termina en ROLLBACK: no deja datos.
    const left = await db.query("SELECT 1 FROM auth.users WHERE email LIKE 't086-%'");
    expect(left.rows).toHaveLength(0);
  });

  it("da el módulo postventa a Alejandro y renombra su perfil (idempotente)", async () => {
    // Sin su perfil en la base, la migración no inserta nada (ya corrió dos veces sin fallar).
    const none = await db.query("SELECT 1 FROM account_module_members WHERE user_id = $1", [ALEJANDRO]);
    expect(none.rows).toHaveLength(0);

    await db.exec(`
      INSERT INTO auth.users (id, email) VALUES ('${ALEJANDRO}', 'alejandro@example.test');
      INSERT INTO accounts (id, name, owner_user_id) VALUES ('${GOLDEN}', 'Golden', '${ALEJANDRO}');
      INSERT INTO profiles (user_id, account_id, account_role, full_name)
        VALUES ('${ALEJANDRO}', '${GOLDEN}', 'agent', 'Asesor Golden 03');
    `);
    await db.exec(sql("086_postventa"));
    await db.exec(sql("086_postventa"));
    const m = await db.query<{ module_key: string }>(
      "SELECT module_key FROM account_module_members WHERE user_id = $1 AND account_id = $2",
      [ALEJANDRO, GOLDEN],
    );
    expect(m.rows).toEqual([{ module_key: "postventa" }]);
    const p = await db.query<{ full_name: string }>("SELECT full_name FROM profiles WHERE user_id = $1", [ALEJANDRO]);
    expect(p.rows[0].full_name).toBe("Alejandro");

    // Si el nombre ya es otro, no se pisa.
    await db.exec(`UPDATE profiles SET full_name = 'Alejandro P.' WHERE user_id = '${ALEJANDRO}'`);
    await db.exec(sql("086_postventa"));
    const p2 = await db.query<{ full_name: string }>("SELECT full_name FROM profiles WHERE user_id = $1", [ALEJANDRO]);
    expect(p2.rows[0].full_name).toBe("Alejandro P.");
  });
});
