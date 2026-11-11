import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// PostgreSQL desechable en memoria (sin credenciales ni BD real). Mismos
// stubs que promueve-089.database.test.ts; aplica 043-086 (más la agenda,
// 049), 019 (canje de invitaciones) y 089, luego 091 dos veces y corre
// supabase/tests/091_casos.sql, el mismo script que el dueño corre en
// producción tras aplicar la migración.
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
    -- 017 + 040: las invitaciones (la tabla real tiene más cosas; aquí lo que usa el canje).
    CREATE TABLE account_invitations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE, role account_role_enum NOT NULL, email text,
      created_by_user_id uuid REFERENCES auth.users ON DELETE SET NULL, label text,
      created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
      accepted_at timestamptz, accepted_by_user_id uuid REFERENCES auth.users ON DELETE SET NULL);
    ALTER TABLE account_invitations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY account_invitations_select ON account_invitations FOR SELECT
      USING (is_account_member(account_id, 'admin'));
    -- Tablas que mira redeem_invitation (019) para no perder datos al unirse.
    CREATE TABLE broadcasts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES accounts ON DELETE CASCADE);
    CREATE TABLE automations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES accounts ON DELETE CASCADE);
    CREATE TABLE flows(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES accounts ON DELETE CASCADE);
    CREATE TABLE pipelines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES accounts ON DELETE CASCADE);
    CREATE TABLE message_templates(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES accounts ON DELETE CASCADE);
    CREATE TABLE tags(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES accounts ON DELETE CASCADE);
    CREATE TABLE custom_fields(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES accounts ON DELETE CASCADE);
    CREATE TABLE contact_notes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES accounts ON DELETE CASCADE);
    CREATE TABLE whatsapp_config(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES accounts ON DELETE CASCADE);
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
  await db.exec(sql("019_invitation_rpcs"));
  await db.exec(sql("089_area_promueve"));
  await db.exec(sql("091_invitacion_promueve"));
  await db.exec(sql("091_invitacion_promueve"));
}, 60000);

afterAll(() => db.close());

describe.sequential("091: invitación Promueve", () => {
  it("pasa todos los casos de supabase/tests/091_casos.sql", async () => {
    const results = await db.exec(readFileSync("supabase/tests/091_casos.sql", "utf8"));
    const ok = results.some((r) => r.rows.some((row) => (row as { resultado?: string }).resultado === "091: todos los casos OK"));
    expect(ok).toBe(true);
    // El script termina en ROLLBACK: no deja datos.
    const left = await db.query("SELECT 1 FROM auth.users WHERE email LIKE 't091-%'");
    expect(left.rows).toHaveLength(0);
  });

  it("la firma de redeem_invitation no cambió (una sola función, un argumento)", async () => {
    const r = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'redeem_invitation'",
    );
    expect(r.rows[0].n).toBe(1);
  });
});
