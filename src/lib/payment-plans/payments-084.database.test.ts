import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// PostgreSQL desechable en memoria (sin credenciales ni BD real). Aplica
// 043-083 sobre stubs mínimos de Supabase, luego 084 dos veces y corre
// supabase/tests/084_casos.sql, el mismo script que el dueño corre en
// producción tras aplicar la migración.
const db = new PGlite();
const sql = (name: string) => readFileSync(`supabase/migrations/${name}.sql`, "utf8");

const OLD_USER = "11111111-0000-4000-8000-000000000001";
const OLD_ACC = "11111111-0000-4000-8000-0000000000a1";
const OLD_PLAN = "11111111-0000-4000-8000-0000000000b1";

type Col = { attname: string; t: string };
const viewColumns = async (view: string) =>
  (
    await db.query<Col>(
      "SELECT attname, format_type(atttypid, atttypmod) t FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 ORDER BY attnum",
      [view],
    )
  ).rows.map((r) => `${r.attname}:${r.t}`);

let before: string[] = [];

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
    CREATE TABLE real_estate_units(id uuid PRIMARY KEY, account_id uuid REFERENCES accounts ON DELETE CASCADE);
    CREATE TABLE reservations(id uuid PRIMARY KEY, account_id uuid REFERENCES accounts ON DELETE CASCADE);
    CREATE TABLE reservation_payments(id uuid PRIMARY KEY, account_id uuid REFERENCES accounts ON DELETE CASCADE);
    CREATE TABLE platform_admins(user_id uuid PRIMARY KEY);
    CREATE FUNCTION public.is_super_admin() RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = public
      AS $$ SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = auth.uid()); $$;
    -- Copia de is_account_member de 067.
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
    "052_recordatorios_cuotas",
    "082_gestiones_cobranza",
    "083_mora_y_abonos",
  ]) {
    await db.exec(sql(m));
  }
  // Datos anteriores a 084: una cuota pagada (para la copia legacy) y una pendiente.
  await db.exec(`
    INSERT INTO auth.users(id, email) VALUES ('${OLD_USER}', 'old@example.test');
    INSERT INTO accounts(id, name, owner_user_id) VALUES ('${OLD_ACC}', 'Vieja', '${OLD_USER}');
    INSERT INTO profiles(user_id, account_id, account_role) VALUES ('${OLD_USER}', '${OLD_ACC}', 'owner');
    INSERT INTO payment_plans(id, account_id, total_amount, installments_count, monthly_amount, first_due_date, status)
      VALUES ('${OLD_PLAN}', '${OLD_ACC}', 1000, 2, 500, '2026-01-01', 'activo');
    INSERT INTO installments(plan_id, account_id, number, amount, due_date, status, paid_amount, paid_at, paid_method, registered_by)
      VALUES ('${OLD_PLAN}', '${OLD_ACC}', 1, 500, '2026-01-01', 'pagada', 450, '2026-01-02 03:00+00', 'Yape',
              (SELECT id FROM profiles WHERE user_id = '${OLD_USER}')),
             ('${OLD_PLAN}', '${OLD_ACC}', 2, 500, '2026-02-01', 'pendiente', NULL, NULL, NULL, NULL);
  `);
  before = await viewColumns("payment_plan_balances");
  await db.exec(sql("084_pagos_protegidos"));
  await db.exec(sql("084_pagos_protegidos"));
}, 60000);

afterAll(() => db.close());

describe.sequential("084: libro de pagos, acceso por módulo y reglas", () => {
  it("se puede volver a correr y mantiene las columnas de payment_plan_balances", async () => {
    const after = await viewColumns("payment_plan_balances");
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)).toBe("adelantada_count:bigint");
  });

  it("copia una sola fila legacy por cuota pagada, con el usuario de Auth", async () => {
    const { rows } = await db.query<{ amount: string; legacy: boolean; registered_by: string; method: string; paid_on: string }>(
      "SELECT amount::text, legacy, registered_by::text, method, paid_on::text FROM installment_payments WHERE account_id = $1",
      [OLD_ACC],
    );
    expect(rows).toEqual([
      { amount: "450.00", legacy: true, registered_by: OLD_USER, method: "Yape", paid_on: "2026-01-01" },
    ]);
  });

  it("pasa todos los casos de supabase/tests/084_casos.sql", async () => {
    const results = await db.exec(readFileSync("supabase/tests/084_casos.sql", "utf8"));
    const ok = results.some((r) => r.rows.some((row) => (row as { resultado?: string }).resultado === "084: todos los casos OK"));
    expect(ok).toBe(true);
    // El script termina en ROLLBACK: no deja datos.
    const left = await db.query("SELECT 1 FROM auth.users WHERE email LIKE 't084-%'");
    expect(left.rows).toHaveLength(0);
  });
});
