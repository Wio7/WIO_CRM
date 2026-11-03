import { readFileSync } from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const CUENTA = "00000000-0000-0000-0000-000000000011";
const OTRA = "00000000-0000-0000-0000-000000000012";
const SARA = "00000000-0000-0000-0000-000000000001";
const ANA = "00000000-0000-0000-0000-000000000002";
const C1 = "00000000-0000-0000-0000-0000000000c1";
const C2 = "00000000-0000-0000-0000-0000000000c2";
const C3 = "00000000-0000-0000-0000-0000000000c3";
const C4 = "00000000-0000-0000-0000-0000000000c4";

let db: PGlite;
const actividad = (cuenta = CUENTA, desde = "2026-10-01T05:00:00Z", hasta = "2026-11-01T05:00:00Z") =>
  db.query<{ user_id: string; recibidos: number; enviados: number; chats: number; dias: string[] }>(
    "SELECT * FROM actividad_del_equipo($1, $2, $3) ORDER BY user_id",
    [cuenta, desde, hasta],
  );

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE conversations (id uuid PRIMARY KEY, account_id uuid, assigned_agent_id uuid);
    CREATE TABLE messages (conversation_id uuid, sender_type text, created_at timestamptz);
    CREATE TABLE permiso (ok boolean);
    INSERT INTO permiso VALUES (true);
    CREATE TYPE account_role_enum AS ENUM ('viewer', 'agent', 'admin', 'owner');
    CREATE FUNCTION is_account_member(target_account_id uuid, min_role account_role_enum DEFAULT 'viewer')
      RETURNS boolean LANGUAGE sql AS 'SELECT ok AND min_role = ''admin'' FROM permiso';

    INSERT INTO conversations VALUES
      ('${C1}', '${CUENTA}', '${SARA}'),
      ('${C2}', '${CUENTA}', '${SARA}'),
      ('${C3}', '${CUENTA}', '${ANA}'),
      ('${C4}', '${CUENTA}', NULL);
    INSERT INTO messages VALUES
      ('${C1}', 'customer', '2026-10-10T15:00:00Z'),
      ('${C1}', 'customer', '2026-10-10T16:00:00Z'),
      ('${C1}', 'agent', '2026-10-10T17:00:00Z'),
      ('${C1}', 'bot', '2026-10-10T18:00:00Z'),
      ('${C2}', 'agent', '2026-10-11T03:00:00Z'),
      ('${C3}', 'customer', '2026-09-30T15:00:00Z'),
      ('${C4}', 'customer', '2026-10-10T15:00:00Z');
  `);
  await db.exec(
    readFileSync(path.resolve(process.cwd(), "supabase/migrations/080_actividad_equipo.sql"), "utf8"),
  );
});

describe("actividad_del_equipo", () => {
  it("cuenta recibidos y enviados por asesor, sin la IA", async () => {
    const { rows } = await actividad();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: SARA, chats: 2 });
    expect(Number(rows[0].recibidos)).toBe(2);
    expect(Number(rows[0].enviados)).toBe(2);
  });

  it("los días van en hora de Lima y sólo cuentan los que escribió", async () => {
    const { rows } = await actividad();
    // 2026-10-11 03:00 UTC son las 22:00 del día 10 en Lima.
    expect(rows[0].dias).toEqual(["2026-10-10"]);
  });

  it("respeta el periodo", async () => {
    const { rows } = await actividad(CUENTA, "2026-09-01T05:00:00Z", "2026-10-01T05:00:00Z");
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(ANA);
  });

  it("no mezcla otras cuentas", async () => {
    expect((await actividad(OTRA)).rows).toEqual([]);
  });

  it("sin ser administrador no devuelve nada", async () => {
    await db.exec("UPDATE permiso SET ok = false");
    await expect(actividad()).rejects.toThrow(/Sin acceso/);
    await db.exec("UPDATE permiso SET ok = true");
  });
});
