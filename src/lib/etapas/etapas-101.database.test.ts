import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// PostgreSQL en memoria: tablas mínimas + 100 + 101 dos veces (idempotente).
// Lo propio de la 101: etapas de Golden y "Separó" al aprobar una separación.

const db = new PGlite();
const BH = "d495a2dc-6d3b-43a1-8841-ab5a1f5a27fe";
const GOLDEN = "d74b5dfd-2999-4e2c-9a0e-10b3d540898b";
const DUENO = "00000000-0000-0000-0000-0000000000a1";

const etapaDe = async (contacto: string) =>
  (
    await db.query<{ clave: string; status: string }>(
      `SELECT s.clave, d.status FROM deals d JOIN pipeline_stages s ON s.id = d.stage_id WHERE d.contact_id = $1`,
      [contacto],
    )
  ).rows;

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TYPE account_role_enum AS ENUM ('owner', 'admin', 'agent', 'viewer');
    CREATE TABLE accounts(id uuid PRIMARY KEY, name text, owner_user_id uuid);
    CREATE TABLE profiles(user_id uuid PRIMARY KEY, account_id uuid, account_role account_role_enum);
    CREATE FUNCTION public.is_account_member(target_account_id uuid, min_role account_role_enum DEFAULT 'viewer')
    RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE TABLE contacts(id uuid PRIMARY KEY, account_id uuid, name text, phone text, phone_normalized text,
      created_at timestamptz DEFAULT now());
    CREATE TABLE conversations(id uuid PRIMARY KEY, account_id uuid, contact_id uuid);
    CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL,
      sender_type text NOT NULL, created_at timestamptz DEFAULT clock_timestamp());
    CREATE TABLE pipelines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, name text,
      created_at timestamptz DEFAULT now());
    CREATE TABLE pipeline_stages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pipeline_id uuid NOT NULL REFERENCES pipelines ON DELETE CASCADE,
      name text NOT NULL, position int NOT NULL DEFAULT 0, color text NOT NULL DEFAULT '#3b82f6', created_at timestamptz DEFAULT now());
    CREATE TABLE deals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, account_id uuid NOT NULL,
      pipeline_id uuid NOT NULL, stage_id uuid NOT NULL REFERENCES pipeline_stages, contact_id uuid NOT NULL,
      conversation_id uuid, title text NOT NULL, status text DEFAULT 'open',
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE appointments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, contact_id uuid,
      status text NOT NULL DEFAULT 'agendada');
    CREATE TABLE gh_lotes_solicitudes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), proyecto text, lote text,
      cliente_nombre text, cliente_telefono text NOT NULL, estado text NOT NULL DEFAULT 'pendiente');

    INSERT INTO accounts VALUES ('${BH}', 'Broker Home', '${DUENO}'), ('${GOLDEN}', 'Golden', '${DUENO}');
    INSERT INTO pipelines(id, account_id, name) VALUES ('10000000-0000-0000-0000-000000000001', '${BH}', 'Sales Pipeline'),
      ('10000000-0000-0000-0000-000000000002', '${GOLDEN}', 'Sales Pipeline');
    INSERT INTO pipeline_stages(pipeline_id, name, position) SELECT p, n, i FROM
      (VALUES ('New Lead', 0), ('Qualified', 1), ('Proposal Sent', 2), ('Negotiation', 3), ('Won', 4)) AS e(n, i),
      (VALUES ('10000000-0000-0000-0000-000000000001'::uuid), ('10000000-0000-0000-0000-000000000002'::uuid)) AS q(p);

    -- Golden: una clienta con chat respondido y una separación ya aprobada antes de la 101.
    INSERT INTO contacts(id, account_id, name, phone, phone_normalized) VALUES
      ('c0000000-0000-0000-0000-000000000001', '${GOLDEN}', 'Ana', '+51 959 251 023', '51959251023'),
      ('c0000000-0000-0000-0000-000000000002', '${GOLDEN}', 'Luis', '987654321', '51987654321'),
      ('c0000000-0000-0000-0000-000000000003', '${GOLDEN}', 'Rosa', '912345678', '51912345678'),
      -- Mismo celular que Luis, pero en Broker Home: no debe moverse.
      ('c0000000-0000-0000-0000-000000000009', '${BH}', 'Luis BH', '987654321', '51987654321');
    INSERT INTO conversations VALUES ('a0000000-0000-0000-0000-000000000001', '${GOLDEN}', 'c0000000-0000-0000-0000-000000000001');
    INSERT INTO messages(conversation_id, sender_type) VALUES ('a0000000-0000-0000-0000-000000000001', 'customer');
    INSERT INTO messages(conversation_id, sender_type) VALUES ('a0000000-0000-0000-0000-000000000001', 'bot');
    INSERT INTO messages(conversation_id, sender_type) VALUES ('a0000000-0000-0000-0000-000000000001', 'customer');
    INSERT INTO gh_lotes_solicitudes(proyecto, lote, cliente_nombre, cliente_telefono, estado)
      VALUES ('colinas-1', 'B-01', 'Rosa', '912 345 678', 'aprobada');
  `);
  for (const m of ["100_etapas_del_cliente", "101_etapas_golden", "101_etapas_golden"]) {
    await db.exec(readFileSync(`supabase/migrations/${m}.sql`, "utf8"));
  }
}, 60000);

afterAll(() => db.close());

describe("101 · etapas de Golden", () => {
  it("Golden queda con 7 etapas en español", async () => {
    const r = await db.query<{ clave: string; name: string }>(
      `SELECT s.clave, s.name FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
       WHERE p.account_id = '${GOLDEN}' ORDER BY s.position`,
    );
    expect(r.rows.map((x) => x.clave)).toEqual(["nuevo", "contesto", "seguimiento", "agendo", "visito", "compro", "perdido"]);
    expect(r.rows[5].name).toBe("Separó / compró");
  });

  it("relleno: chat respondido → Contestó; separación ya aprobada → Separó", async () => {
    expect(await etapaDe("c0000000-0000-0000-0000-000000000001")).toEqual([{ clave: "contesto", status: "open" }]);
    expect(await etapaDe("c0000000-0000-0000-0000-000000000003")).toEqual([{ clave: "compro", status: "won" }]);
  });

  it("al aprobar una separación el cliente de Golden pasa a Separó, aunque el celular venga escrito distinto", async () => {
    await db.exec(`INSERT INTO gh_lotes_solicitudes(id, proyecto, lote, cliente_nombre, cliente_telefono)
      VALUES ('e0000000-0000-0000-0000-000000000001', 'colinas-2', 'A-12', 'Luis', '+51 987-654-321')`);
    expect(await etapaDe("c0000000-0000-0000-0000-000000000002")).toEqual([]);
    await db.exec(`UPDATE gh_lotes_solicitudes SET estado = 'aprobada' WHERE id = 'e0000000-0000-0000-0000-000000000001'`);
    expect(await etapaDe("c0000000-0000-0000-0000-000000000002")).toEqual([{ clave: "compro", status: "won" }]);
    // El contacto de Broker Home con el mismo celular no se toca.
    expect(await etapaDe("c0000000-0000-0000-0000-000000000009")).toEqual([]);
  });

  it("un celular que no es de ningún cliente no mueve nada y la aprobación se guarda", async () => {
    await db.exec(`INSERT INTO gh_lotes_solicitudes(id, cliente_telefono) VALUES ('e0000000-0000-0000-0000-000000000002', '900000000');
      UPDATE gh_lotes_solicitudes SET estado = 'aprobada' WHERE id = 'e0000000-0000-0000-0000-000000000002'`);
    const r = await db.query<{ estado: string }>(`SELECT estado FROM gh_lotes_solicitudes WHERE id = 'e0000000-0000-0000-0000-000000000002'`);
    expect(r.rows[0].estado).toBe("aprobada");
  });

  it("si mover la etapa falla, la aprobación igual se guarda", async () => {
    await db.exec(`ALTER TABLE deals RENAME TO deals_fuera`);
    try {
      await db.exec(`INSERT INTO contacts(id, account_id, name, phone, phone_normalized)
          VALUES ('c0000000-0000-0000-0000-000000000004', '${GOLDEN}', 'Eva', '911111111', '51911111111');
        INSERT INTO gh_lotes_solicitudes(id, cliente_telefono) VALUES ('e0000000-0000-0000-0000-000000000003', '911111111');
        UPDATE gh_lotes_solicitudes SET estado = 'aprobada' WHERE id = 'e0000000-0000-0000-0000-000000000003'`);
      const r = await db.query<{ estado: string }>(`SELECT estado FROM gh_lotes_solicitudes WHERE id = 'e0000000-0000-0000-0000-000000000003'`);
      expect(r.rows[0].estado).toBe("aprobada");
    } finally {
      await db.exec(`ALTER TABLE deals_fuera RENAME TO deals`);
    }
  });

  it("Broker Home sigue con sus etapas (la 101 no la toca)", async () => {
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
       WHERE p.account_id = '${BH}' AND s.clave IS NOT NULL`,
    );
    expect(r.rows[0].n).toBe(7);
  });
});
