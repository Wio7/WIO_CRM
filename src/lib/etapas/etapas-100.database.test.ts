import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// PostgreSQL en memoria con las tablas mínimas (mismas columnas que producción
// para lo que toca la 100). Aplica la 100 dos veces: tiene que ser idempotente.

const db = new PGlite();
const BH = "d495a2dc-6d3b-43a1-8841-ab5a1f5a27fe";
const GOLDEN = "d74b5dfd-2999-4e2c-9a0e-10b3d540898b";
const JULIO = "00000000-0000-0000-0000-0000000000a1";
const EXTRANO = "00000000-0000-0000-0000-0000000000b2";

const etapaDe = async (contacto: string) => {
  const r = await db.query<{ clave: string; status: string }>(
    `SELECT s.clave, d.status FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id WHERE d.contact_id = $1`,
    [contacto],
  );
  return r.rows;
};
const comoUsuario = async (uid: string | null, q: string) => {
  await db.exec(`SET request.jwt.claim.sub = '${uid ?? ""}'`);
  try {
    return await db.query(q);
  } finally {
    await db.exec(`SET request.jwt.claim.sub = ''`);
  }
};

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TYPE account_role_enum AS ENUM ('owner', 'admin', 'agent', 'viewer');
    CREATE TABLE accounts(id uuid PRIMARY KEY, name text, owner_user_id uuid);
    CREATE TABLE profiles(user_id uuid PRIMARY KEY, account_id uuid, account_role account_role_enum);
    CREATE FUNCTION public.is_account_member(target_account_id uuid, min_role account_role_enum DEFAULT 'viewer')
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = auth.uid() AND p.account_id = target_account_id
        AND CASE p.account_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 ELSE 1 END
         >= CASE min_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 ELSE 1 END) $$;
    CREATE TABLE contacts(id uuid PRIMARY KEY, account_id uuid, name text, phone text);
    CREATE TABLE conversations(id uuid PRIMARY KEY, account_id uuid, contact_id uuid);
    CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL,
      sender_type text NOT NULL CHECK (sender_type IN ('customer', 'agent', 'bot')), content_text text,
      created_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE pipelines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, name text,
      created_at timestamptz DEFAULT now());
    CREATE TABLE pipeline_stages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pipeline_id uuid NOT NULL REFERENCES pipelines ON DELETE CASCADE,
      name text NOT NULL, position int NOT NULL DEFAULT 0, color text NOT NULL DEFAULT '#3b82f6', created_at timestamptz DEFAULT now());
    CREATE TABLE deals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, account_id uuid NOT NULL,
      pipeline_id uuid NOT NULL, stage_id uuid NOT NULL REFERENCES pipeline_stages, contact_id uuid NOT NULL,
      conversation_id uuid, title text NOT NULL, value numeric DEFAULT 0, status text DEFAULT 'open'
      CHECK (status IN ('open', 'won', 'lost')), created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE appointments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, contact_id uuid,
      user_id uuid, starts_at timestamptz DEFAULT now(), status text NOT NULL DEFAULT 'agendada'
      CHECK (status IN ('agendada', 'cumplida', 'cancelada')));

    INSERT INTO accounts VALUES ('${BH}', 'Broker Home', '${JULIO}'), ('${GOLDEN}', 'Golden', '${JULIO}');
    INSERT INTO profiles VALUES ('${JULIO}', '${BH}', 'owner');
    INSERT INTO pipelines(id, account_id, name) VALUES ('10000000-0000-0000-0000-000000000001', '${BH}', 'Sales Pipeline'),
      ('10000000-0000-0000-0000-000000000002', '${GOLDEN}', 'Sales Pipeline');
    INSERT INTO pipeline_stages(pipeline_id, name, position) SELECT p, n, i FROM
      (VALUES ('New Lead', 0), ('Qualified', 1), ('Proposal Sent', 2), ('Negotiation', 3), ('Won', 4)) AS e(n, i),
      (VALUES ('10000000-0000-0000-0000-000000000001'::uuid), ('10000000-0000-0000-0000-000000000002'::uuid)) AS q(p);

    -- Un cliente que ya escribió y al que la IA le contestó, antes de la 100.
    INSERT INTO contacts VALUES ('c0000000-0000-0000-0000-000000000001', '${BH}', 'Karina', '51900000001');
    INSERT INTO conversations VALUES ('a0000000-0000-0000-0000-000000000001', '${BH}', 'c0000000-0000-0000-0000-000000000001');
    INSERT INTO messages(conversation_id, sender_type) VALUES ('a0000000-0000-0000-0000-000000000001', 'customer');
    INSERT INTO messages(conversation_id, sender_type) VALUES ('a0000000-0000-0000-0000-000000000001', 'bot');
    INSERT INTO messages(conversation_id, sender_type) VALUES ('a0000000-0000-0000-0000-000000000001', 'customer');
  `);
  const m = readFileSync("supabase/migrations/100_etapas_del_cliente.sql", "utf8");
  await db.exec(m);
  await db.exec(m);
}, 60000);

afterAll(() => db.close());

describe("100 · etapas del cliente", () => {
  it("Broker Home queda con 7 etapas en español y Golden no cambia", async () => {
    const bh = await db.query<{ name: string; clave: string }>(
      `SELECT s.name, s.clave FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
       WHERE p.account_id = '${BH}' ORDER BY s.position`,
    );
    expect(bh.rows.map((r) => r.clave)).toEqual(["nuevo", "contesto", "seguimiento", "agendo", "visito", "compro", "perdido"]);
    expect(bh.rows[1].name).toBe("Contestó");
    const golden = await db.query(`SELECT 1 FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
       WHERE p.account_id = '${GOLDEN}' AND s.clave IS NOT NULL`);
    expect(golden.rows).toHaveLength(0);
  });

  it("el relleno pone en Contestó a quien respondió, y solo una vez", async () => {
    expect(await etapaDe("c0000000-0000-0000-0000-000000000001")).toEqual([{ clave: "contesto", status: "open" }]);
  });

  it("primer mensaje = Nuevo; al responder después de la IA = Contestó", async () => {
    await db.exec(`
      INSERT INTO contacts VALUES ('c0000000-0000-0000-0000-000000000002', '${BH}', 'Jhonson', '51900000002');
      INSERT INTO conversations VALUES ('a0000000-0000-0000-0000-000000000002', '${BH}', 'c0000000-0000-0000-0000-000000000002');
      INSERT INTO messages(conversation_id, sender_type) VALUES ('a0000000-0000-0000-0000-000000000002', 'customer');
    `);
    expect(await etapaDe("c0000000-0000-0000-0000-000000000002")).toEqual([{ clave: "nuevo", status: "open" }]);
    await db.exec(`
      INSERT INTO messages(conversation_id, sender_type) VALUES ('a0000000-0000-0000-0000-000000000002', 'bot');
      INSERT INTO messages(conversation_id, sender_type) VALUES ('a0000000-0000-0000-0000-000000000002', 'customer');
    `);
    expect(await etapaDe("c0000000-0000-0000-0000-000000000002")).toEqual([{ clave: "contesto", status: "open" }]);
  });

  it("cita → Agendó, cumplida → Visitó, y un mensaje nuevo no lo regresa", async () => {
    await db.exec(`INSERT INTO appointments(id, account_id, contact_id) VALUES
      ('e0000000-0000-0000-0000-000000000001', '${BH}', 'c0000000-0000-0000-0000-000000000002')`);
    expect((await etapaDe("c0000000-0000-0000-0000-000000000002"))[0].clave).toBe("agendo");
    await db.exec(`UPDATE appointments SET status = 'cumplida' WHERE id = 'e0000000-0000-0000-0000-000000000001'`);
    expect((await etapaDe("c0000000-0000-0000-0000-000000000002"))[0].clave).toBe("visito");
    await db.exec(`INSERT INTO messages(conversation_id, sender_type) VALUES ('a0000000-0000-0000-0000-000000000002', 'customer')`);
    expect(await etapaDe("c0000000-0000-0000-0000-000000000002")).toHaveLength(1);
    expect((await etapaDe("c0000000-0000-0000-0000-000000000002"))[0].clave).toBe("visito");
  });

  it("a mano (forzado) puede volver atrás y marcar compró como ganado", async () => {
    const r = await comoUsuario(JULIO, `SELECT mover_etapa_cliente('${BH}', 'c0000000-0000-0000-0000-000000000002', NULL, 'compro', true) AS c`);
    expect((r.rows[0] as { c: string }).c).toBe("compro");
    expect(await etapaDe("c0000000-0000-0000-0000-000000000002")).toEqual([{ clave: "compro", status: "won" }]);
    // Compró es final: la IA (sin forzar) no lo mueve.
    await db.query(`SELECT mover_etapa_cliente('${BH}', 'c0000000-0000-0000-0000-000000000002', NULL, 'seguimiento', false)`);
    expect((await etapaDe("c0000000-0000-0000-0000-000000000002"))[0].clave).toBe("compro");
  });

  it("alguien de otra cuenta no puede mover clientes de Broker Home", async () => {
    await expect(
      comoUsuario(EXTRANO, `SELECT mover_etapa_cliente('${BH}', 'c0000000-0000-0000-0000-000000000001', NULL, 'perdido', true)`),
    ).rejects.toThrow(/sin acceso/);
  });

  it("en Golden (sin claves) no crea nada", async () => {
    await db.exec(`
      INSERT INTO contacts VALUES ('c0000000-0000-0000-0000-000000000009', '${GOLDEN}', 'Ana', '51900000009');
      INSERT INTO conversations VALUES ('a0000000-0000-0000-0000-000000000009', '${GOLDEN}', 'c0000000-0000-0000-0000-000000000009');
      INSERT INTO messages(conversation_id, sender_type) VALUES ('a0000000-0000-0000-0000-000000000009', 'customer');
    `);
    expect(await etapaDe("c0000000-0000-0000-0000-000000000009")).toHaveLength(0);
  });

  it("un cliente de otra cuenta no entra al embudo de Broker Home", async () => {
    const r = await db.query(`SELECT mover_etapa_cliente('${BH}', 'c0000000-0000-0000-0000-000000000009', NULL, 'nuevo', false) AS c`);
    expect((r.rows[0] as { c: string | null }).c).toBeNull();
  });
});
