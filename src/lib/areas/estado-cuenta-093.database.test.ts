import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// PostgreSQL desechable en memoria (sin credenciales ni BD real). Mismos
// stubs que promueve-089.database.test.ts; aplica 043-085 (más la agenda,
// 049), la caja (063-065), 087 (cash_panel_access), 089 (Promueve), luego 092
// dos veces y corre supabase/tests/093_casos.sql, el mismo script que el
// dueño corre en producción tras aplicar la migración.
const db = new PGlite();
let antes: { proname: string; md5: string }[] = [];
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
    CREATE POLICY profiles_select ON profiles FOR SELECT USING (user_id = auth.uid() OR is_account_member(account_id));
    CREATE POLICY profiles_update ON profiles FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
    ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE accounts ADD COLUMN agents_see_only_assigned boolean NOT NULL DEFAULT false;
    CREATE FUNCTION can_access_conversation(p_account_id UUID, p_assigned_agent_id UUID, p_min_role account_role_enum DEFAULT 'viewer')
    RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT is_account_member(p_account_id, p_min_role)
        AND (is_account_member(p_account_id, 'admin') OR p_assigned_agent_id = auth.uid()
          OR NOT COALESCE((SELECT a.agents_see_only_assigned FROM accounts a WHERE a.id = p_account_id), false));
    $$;
    CREATE POLICY conversations_select ON conversations FOR SELECT USING (can_access_conversation(account_id, assigned_agent_id));
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
  // La 075 vive en el repo de la caja; aquí solo hace falta saber quién es dueño de caja.
  await db.exec(`
    CREATE FUNCTION public.cash_is_owner() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
      SELECT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = auth.uid() AND account_role = 'owner')
    $$;
  `);
  await db.exec(sql("087_caja_proyecto_rubro"));
  await db.exec(sql("092_area_administracion"));
  // Huella de las funciones que 093 NO debe reemplazar (la base real se desvía del repo).
  const huellas = await db.query<{ proname: string; md5: string }>(
    `SELECT proname, md5(pg_get_functiondef(oid)) AS md5 FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
      ORDER BY proname, oid`,
  );
  antes = huellas.rows;
  await db.exec(sql("093_estado_cuenta_banco"));
  await db.exec(sql("093_estado_cuenta_banco"));
}, 90000);

afterAll(() => db.close());

describe.sequential("093: estado de cuenta de la Caja Ica", () => {
  it("pasa todos los casos de supabase/tests/093_casos.sql", async () => {
    const results = await db.exec(readFileSync("supabase/tests/093_casos.sql", "utf8"));
    const ok = results.some((r) => r.rows.some((row) => (row as { resultado?: string }).resultado === "093: todos los casos OK"));
    expect(ok).toBe(true);
    // El script termina en ROLLBACK: no deja datos.
    const left = await db.query("SELECT 1 FROM auth.users WHERE email LIKE 't093-%'");
    expect(left.rows).toHaveLength(0);
    const movs = await db.query("SELECT 1 FROM bank_statement_movements");
    expect(movs.rows).toHaveLength(0);
  });

  it("no reemplaza ninguna función que ya existía: solo agrega las cuatro nuevas", async () => {
    const despues = await db.query<{ proname: string; md5: string }>(
      `SELECT proname, md5(pg_get_functiondef(oid)) AS md5 FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
        ORDER BY proname, oid`,
    );
    const antesSet = new Set(antes.map((f) => `${f.proname}:${f.md5}`));
    const nuevas = despues.rows.filter((f) => !antesSet.has(`${f.proname}:${f.md5}`)).map((f) => f.proname).sort();
    expect(nuevas).toEqual(["bank_statement_access", "import_bank_statement", "set_movement_match", "set_movement_matches"]);
    // Y ninguna de las que había cambió ni desapareció.
    const despuesSet = new Set(despues.rows.map((f) => `${f.proname}:${f.md5}`));
    expect(antes.filter((f) => !despuesSet.has(`${f.proname}:${f.md5}`))).toEqual([]);
  });

  it("es idempotente: aplicar de nuevo no duplica policies ni índices", async () => {
    const pol = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_policies WHERE tablename IN ('bank_statement_imports', 'bank_statement_movements')",
    );
    expect(pol.rows[0].n).toBe(2);
    const idx = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'bank_statement_movements' ORDER BY indexname",
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual([
      "bank_statement_movements_huella_unica",
      "bank_statement_movements_pkey",
      "bank_statement_movements_un_pago",
      "idx_bank_statement_movements_estado",
      "idx_bank_statement_movements_fecha",
    ]);
  });

  it("las tablas son de solo lectura para authenticated y cerradas para anon", async () => {
    const r = await db.query<{ grantee: string; privilege_type: string }>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'bank_statement_movements' AND grantee IN ('anon', 'authenticated')
        ORDER BY grantee, privilege_type`,
    );
    expect(r.rows).toEqual([{ grantee: "authenticated", privilege_type: "SELECT" }]);
  });
});
