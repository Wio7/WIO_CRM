import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// PostgreSQL desechable en memoria: nunca usa credenciales ni una BD real.
const db = new PGlite();
const admin = "00000000-0000-0000-0000-000000000001";
const owner = "00000000-0000-0000-0000-000000000002";
const agent = "00000000-0000-0000-0000-000000000003";
const home = "00000000-0000-0000-0000-000000000011";
const client = "00000000-0000-0000-0000-000000000012";
const inactive = "00000000-0000-0000-0000-000000000013";
const missing = "00000000-0000-0000-0000-000000000099";
const migration = readFileSync("supabase/migrations/067_platform_admins.sql", "utf8");
const sql = (name: string) => readFileSync(`supabase/migrations/${name}.sql`, "utf8");
const as = (user: string) => db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [user]);
const enter = (id: string) => db.query("SELECT platform_admin_enter_account($1::uuid)", [id]);
const exit = () => db.query("SELECT platform_admin_exit_account()");
async function membership(id: string) {
  return (await db.query<{ allowed: boolean }>("SELECT is_account_member($1::uuid, 'owner') AS allowed", [id])).rows[0].allowed;
}
async function profile() {
  return (await db.query("SELECT account_id, account_role FROM profiles WHERE user_id = auth.uid()")).rows[0];
}

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, email text);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon;
    CREATE TYPE account_role_enum AS ENUM ('owner', 'admin', 'agent', 'viewer');
    CREATE TABLE accounts(id uuid PRIMARY KEY, name text, owner_user_id uuid REFERENCES auth.users);
    CREATE TABLE profiles(user_id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
      account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
      account_role account_role_enum NOT NULL, full_name text, email text);
    CREATE TABLE contacts(id uuid PRIMARY KEY, account_id uuid, user_id uuid);
    CREATE TABLE conversations(id uuid PRIMARY KEY, account_id uuid, contact_id uuid, assigned_agent_id uuid);
    CREATE TABLE messages(id uuid PRIMARY KEY, conversation_id uuid, sender_type text);
    INSERT INTO auth.users VALUES ('${admin}', 'brycebueno15@gmail.com'), ('${owner}', 'owner@test.local'), ('${agent}', 'wiocompany7@gmail.com');
    INSERT INTO accounts VALUES ('${home}', 'Agencia', '${admin}'), ('${client}', 'Golden Test', '${owner}'), ('${inactive}', 'Inactiva', '${owner}');
    INSERT INTO profiles VALUES ('${admin}', '${home}', 'admin', 'Bryce', ''), ('${owner}', '${client}', 'owner', 'Dueño', ''), ('${agent}', '${client}', 'agent', 'Asesor', '');
    INSERT INTO contacts VALUES ('${home}', '${home}', '${admin}'), ('${client}', '${client}', '${owner}');
    INSERT INTO conversations VALUES ('${home}', '${client}', '${client}', '${owner}'), ('${client}', '${client}', '${client}', '${agent}');
    ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
    ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY profiles_select ON profiles FOR SELECT USING (user_id = auth.uid());
    CREATE POLICY profiles_update ON profiles FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
    GRANT SELECT, UPDATE, INSERT, DELETE ON accounts, profiles, contacts, conversations TO authenticated;
  `);
  await db.exec(sql("031_saas_features"));
  // Función y políticas originales de 039; no sustituirlas por un mock.
  await db.exec(sql("039_advisor_ownership").split("DROP POLICY IF EXISTS messages_select")[0]);
  await db.exec(sql("041_clients_and_ai_handoff"));
  await db.exec(sql("057_jerarquia_equipo"));
  await db.exec("UPDATE accounts SET status = 'inactive' WHERE id = '" + inactive + "'; UPDATE accounts SET agents_see_only_assigned = true;");
  await db.exec(sql("063_golden_caja"));
  await db.exec(sql("064_cash_private_boxes_audit"));
  await db.exec(sql("065_cash_companies"));
  await db.exec(migration);
  await db.exec("SET ROLE authenticated");
}, 30000);

afterAll(() => db.close());

describe.sequential("superadmin: RPC, RLS y caja", () => {
  it("rechaza a anónimos, owners y asesores; no permite editar la pertenencia por REST", async () => {
    for (const user of ["", owner, agent]) {
      await as(user);
      await expect(enter(home)).rejects.toThrow("Requiere superadmin");
      await expect(exit()).rejects.toThrow("Requiere superadmin");
      expect((await db.query("SELECT * FROM platform_admins")).rows).toHaveLength(0);
    }
    await expect(db.query("UPDATE profiles SET account_id = $1 WHERE user_id = auth.uid()", [home])).rejects.toThrow("función autorizada");
    await expect(db.query("INSERT INTO platform_admins(user_id, home_account_id) VALUES ($1, $2)", [agent, client])).rejects.toThrow("permission denied");
  });

  it("mantiene el aislamiento de asesores de 039", async () => {
    await as(agent);
    expect((await db.query("SELECT id FROM conversations")).rows).toEqual([{ id: client }]);
    expect(await membership(home)).toBe(false);
  });

  it("entra como owner, pierde acceso a casa y caja sigue el perfil", async () => {
    await as(admin);
    await enter(client);
    expect(await profile()).toEqual({ account_id: client, account_role: "owner" });
    expect(await membership(client)).toBe(true);
    expect(await membership(home)).toBe(false);
    expect((await db.query("SELECT id FROM contacts")).rows).toEqual([{ id: client }]);
    expect((await db.query("SELECT id FROM accounts")).rows).toHaveLength(3);
    expect((await db.query<{ role: string }>("SELECT cash_role($1) AS role", [client])).rows[0].role).toBe("owner");
    const companies = await db.query<{ data: { id: string }[] }>("SELECT cash_company_list() AS data");
    expect(companies.rows[0].data.map(c => c.id)).toEqual([client]);
    await expect(db.query("SELECT cash_company_snapshot($1)", [home])).rejects.toThrow("Sin acceso financiero");
    await expect(db.query("UPDATE contacts SET user_id = $1 WHERE id = $2 RETURNING id", [admin, home])).resolves.toMatchObject({ rows: [] });
  });

  it("no deja estado parcial ante una cuenta inexistente", async () => {
    await expect(enter(missing)).rejects.toThrow("Cuenta no encontrada");
    expect(await profile()).toEqual({ account_id: client, account_role: "owner" });
    expect((await db.query("SELECT * FROM platform_admin_audit WHERE exited_at IS NULL")).rows).toHaveLength(1);
  });

  it("permite trabajar en equipo y registrar caja únicamente en el cliente", async () => {
    await db.query("SELECT set_member_role($1, 'admin')", [agent]);
    await db.query("SELECT set_member_role($1, 'agent')", [agent]);
    await db.query("SELECT cash_company_command($1::jsonb)", [JSON.stringify({
      action: "entry", companyId: client, requestId: missing,
      kind: "income", amountCents: 1000, concept: "Visita de soporte",
      counterparty: "Prueba", date: "2026-10-20",
    })]);
    expect((await db.query("SELECT account_id FROM cash_entries")).rows).toEqual([{ account_id: client }]);
    await db.query("UPDATE profiles SET full_name = 'Bryce editado' WHERE user_id = auth.uid()");
    await expect(db.query("UPDATE profiles SET account_role = 'viewer' WHERE user_id = auth.uid()")).rejects.toThrow("función autorizada");
  });

  it("revierte perfil y visita si la escritura de auditoría falla", async () => {
    await db.exec(`RESET ROLE;
      CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fallo de auditoría simulado'; END $$;
      CREATE TRIGGER fail_audit BEFORE INSERT ON platform_admin_audit FOR EACH ROW EXECUTE FUNCTION fail_audit();
      SET ROLE authenticated;`);
    await expect(enter(inactive)).rejects.toThrow("Fallo de auditoría simulado");
    expect(await profile()).toEqual({ account_id: client, account_role: "owner" });
    expect((await db.query("SELECT visiting_account_id FROM platform_admins")).rows).toEqual([{ visiting_account_id: client }]);
    expect((await db.query("SELECT account_id FROM platform_admin_audit WHERE exited_at IS NULL")).rows).toEqual([{ account_id: client }]);
    await db.exec("RESET ROLE; DROP TRIGGER fail_audit ON platform_admin_audit; SET ROLE authenticated;");
  });

  it("permite saltar a una cuenta inactiva y cierra la auditoría anterior", async () => {
    await enter(inactive);
    expect(await membership(inactive)).toBe(true);
    expect(await membership(client)).toBe(false);
    expect((await db.query("SELECT account_id FROM platform_admin_audit WHERE exited_at IS NULL")).rows).toEqual([{ account_id: inactive }]);
    expect((await db.query("SELECT * FROM platform_admin_audit WHERE exited_at IS NOT NULL")).rows).toHaveLength(1);
  });

  it("es idempotente y no sobrescribe casa al reaplicar durante una visita", async () => {
    await db.exec("RESET ROLE");
    await db.exec(migration);
    await db.exec("SET ROLE authenticated");
    expect((await db.query("SELECT home_account_id FROM platform_admins")).rows).toEqual([{ home_account_id: home }]);
    expect(await profile()).toEqual({ account_id: inactive, account_role: "owner" });
  });

  it("protege la cuenta visitada y la casa del borrado", async () => {
    await expect(db.query("DELETE FROM accounts WHERE id = $1", [inactive])).rejects.toThrow("Sal de la cuenta");
    await expect(db.query("DELETE FROM accounts WHERE id = $1", [home])).rejects.toThrow("foreign key");
  });

  it("restaura exactamente cuenta y rol, incluso al salir dos veces", async () => {
    await exit();
    await exit();
    expect(await profile()).toEqual({ account_id: home, account_role: "admin" });
    expect((await db.query("SELECT visiting_account_id FROM platform_admins")).rows).toEqual([{ visiting_account_id: null }]);
    expect((await db.query("SELECT * FROM platform_admin_audit WHERE exited_at IS NULL")).rows).toHaveLength(0);
    expect(await membership(client)).toBe(false);
    await as(owner);
    expect((await db.query("SELECT * FROM platform_admin_audit")).rows).toHaveLength(0);
  });

  it("tolera la ausencia del correo y permite sembrar al editarlo después", async () => {
    await db.exec("RESET ROLE");
    await db.exec(`DELETE FROM platform_admins; UPDATE auth.users SET email = 'pendiente@test.local' WHERE id = '${admin}';`);
    await db.exec(migration);
    expect((await db.query("SELECT * FROM platform_admins")).rows).toHaveLength(0);
    await db.exec(`UPDATE auth.users SET email = 'BRYCEBUENO15@gmail.com' WHERE id = '${admin}';`);
    await db.exec(migration);
    expect((await db.query("SELECT home_account_id, home_account_role FROM platform_admins")).rows).toEqual([{ home_account_id: home, home_account_role: "admin" }]);
  });
});
