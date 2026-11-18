import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// PostgreSQL desechable en memoria (sin credenciales ni BD real). Arma las
// tablas con la forma vigente antes de 103 (whatsapp_config de 001/013/017,
// CHECK de area de 092 y 091, politicas de 039), usa la funcion REAL
// can_access_conversation de 055 (extraida del archivo) y aplica 103 dos
// veces para comprobar que es idempotente.
const db = new PGlite();
const sql = (name: string) => readFileSync(`supabase/migrations/${name}.sql`, "utf8");

// Bloque CREATE OR REPLACE FUNCTION <nombre> de una migración (hasta su ALTER FUNCTION).
function funcionDe(migracion: string, nombre: string, fin = `ALTER FUNCTION ${nombre}`): string {
  const s = sql(migracion);
  const start = s.indexOf(`CREATE OR REPLACE FUNCTION ${nombre}(`);
  const end = s.indexOf(fin, start);
  if (start < 0 || end < 0) throw new Error(`no se encontro ${nombre} en ${migracion}`);
  return s.slice(start, end);
}
const funcion055 = () => funcionDe("055_privacidad_y_reparto", "can_access_conversation");

const ACCT = "a0000000-0000-0000-0000-000000000001";
const U = {
  owner: "00000000-0000-0000-0000-0000000000a1",
  adminSinArea: "00000000-0000-0000-0000-0000000000a2",
  gerencia: "00000000-0000-0000-0000-0000000000a3",
  legal: "00000000-0000-0000-0000-0000000000a4",
  agente: "00000000-0000-0000-0000-0000000000a5",
  agenteLegal: "00000000-0000-0000-0000-0000000000a6",
};

async function puede(user: string, assigned: string | null, area: string | null): Promise<boolean> {
  await db.exec(`SELECT set_config('request.jwt.claim.sub', '${user}', false)`);
  const r = await db.query<{ ok: boolean }>(
    `SELECT can_access_conversation($1::uuid, $2::uuid, $3::text) AS ok`,
    [ACCT, assigned, area],
  );
  return r.rows[0].ok;
}

async function setRestringido(v: boolean) {
  await db.exec(`UPDATE accounts SET agents_see_only_assigned = ${v}`);
}

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, email text);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE TYPE account_role_enum AS ENUM ('owner', 'admin', 'agent', 'viewer');
    CREATE TABLE accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text,
      status text NOT NULL DEFAULT 'active', viewers_are_clients boolean NOT NULL DEFAULT false,
      agents_see_only_assigned boolean NOT NULL DEFAULT false,
      auto_assign_new_conversations boolean NOT NULL DEFAULT false);
    CREATE TABLE profiles(id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
      user_id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
      account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
      account_role account_role_enum NOT NULL, area text, area_set_by uuid, area_set_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp());
    CREATE TABLE payment_plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid, status text);
    -- 092:43
    ALTER TABLE profiles ADD CONSTRAINT profiles_area_check
      CHECK (area IS NULL OR area IN ('marketing', 'legal', 'cobranzas', 'ventas', 'gerencia', 'contabilidad', 'tecnica', 'promueve', 'administracion'));
    -- 017 + 091
    CREATE TABLE account_invitations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE, role text NOT NULL DEFAULT 'agent', area text);
    ALTER TABLE account_invitations ADD CONSTRAINT account_invitations_area_check
      CHECK (area IS NULL OR (area = 'promueve' AND role = 'agent'));
    -- 001 + 013 + 015 + 017 + 077 (columnas relevantes)
    CREATE TABLE whatsapp_config(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
      account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
      phone_number_id text NOT NULL, waba_id text, access_token text NOT NULL, verify_token text,
      status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected')),
      registered_at timestamptz,
      connection_type text NOT NULL DEFAULT 'manual' CHECK (connection_type IN ('manual', 'embedded', 'coexistence')),
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      CONSTRAINT whatsapp_config_phone_number_id_key UNIQUE (phone_number_id),
      CONSTRAINT whatsapp_config_account_id_key UNIQUE (account_id));
    CREATE TABLE conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid REFERENCES accounts ON DELETE CASCADE, contact_id uuid, assigned_agent_id uuid,
      status text NOT NULL DEFAULT 'open');
    CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id uuid REFERENCES conversations ON DELETE CASCADE);
    ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
    -- is_account_member de 067
    CREATE FUNCTION public.is_super_admin() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.is_account_member(target_account_id UUID, min_role account_role_enum DEFAULT 'viewer')
    RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT EXISTS (SELECT 1 FROM public.profiles p JOIN public.accounts a ON a.id = p.account_id
        WHERE p.user_id = auth.uid() AND p.account_id = target_account_id
          AND (a.status = 'active' OR public.is_super_admin())
          AND NOT (p.account_role = 'viewer' AND a.viewers_are_clients)
          AND CASE p.account_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END
           >= CASE min_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END);
    $$;
  `);
  await db.exec(funcion055());
  // Reparto real (060, 062); pick_account_agent (089) se simula: devuelve el
  // "comodín" para ver cuándo se cae al reparto general.
  await db.exec(funcionDe("060_asesor_sin_area", "pick_area_agent"));
  await db.exec(funcionDe("062_jefa_califica_y_delega", "pick_sales_head", "-- El asesor de ventas menos cargado"));
  await db.exec(`CREATE FUNCTION pick_account_agent(p UUID) RETURNS UUID LANGUAGE sql AS $$
    SELECT '00000000-0000-0000-0000-0000000000ff'::uuid $$;`);
  await db.exec(`
    -- 039:86-105
    CREATE POLICY conversations_select ON conversations FOR SELECT
      USING (can_access_conversation(account_id, assigned_agent_id));
    CREATE POLICY messages_select ON messages FOR SELECT USING (
      EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id
        AND can_access_conversation(c.account_id, c.assigned_agent_id)));
    GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
    GRANT SELECT ON auth.users TO authenticated;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;

    INSERT INTO accounts(id, name) VALUES ('${ACCT}', 'Cuenta');
    INSERT INTO auth.users(id, email) VALUES
      ('${U.owner}', 'o@t'), ('${U.adminSinArea}', 'a@t'), ('${U.gerencia}', 'g@t'),
      ('${U.legal}', 'l@t'), ('${U.agente}', 'ag@t'), ('${U.agenteLegal}', 'al@t');
    INSERT INTO profiles(user_id, account_id, account_role, area) VALUES
      ('${U.owner}', '${ACCT}', 'owner', NULL),
      ('${U.adminSinArea}', '${ACCT}', 'admin', NULL),
      ('${U.gerencia}', '${ACCT}', 'admin', 'gerencia'),
      ('${U.legal}', '${ACCT}', 'admin', 'legal'),
      ('${U.agente}', '${ACCT}', 'agent', NULL),
      ('${U.agenteLegal}', '${ACCT}', 'agent', 'legal');
    -- Estado previo a 103: una linea por cuenta, una conversacion ya existente.
    INSERT INTO whatsapp_config(id, user_id, account_id, phone_number_id, access_token)
      VALUES ('b0000000-0000-0000-0000-000000000001', '${U.owner}', '${ACCT}', 'PN-1', 'tok');
    INSERT INTO conversations(id, account_id, assigned_agent_id)
      VALUES ('c0000000-0000-0000-0000-000000000001', '${ACCT}', NULL);
  `);
  const m = sql("103_whatsapp_lineas");
  await db.exec(m);
  await db.exec(m);
}, 60000);

afterAll(() => db.close());

describe.sequential("103: lineas de WhatsApp por cuenta", () => {
  it("rellena la linea existente como principal y la conversacion con su line_id", async () => {
    const l = await db.query<{ is_primary: boolean; line_name: string; sort_order: number }>(
      `SELECT is_primary, line_name, sort_order FROM whatsapp_config WHERE phone_number_id = 'PN-1'`,
    );
    expect(l.rows[0]).toEqual({ is_primary: true, line_name: "Principal", sort_order: 0 });
    const c = await db.query<{ line_id: string; area: string | null }>(
      `SELECT line_id, area FROM conversations WHERE id = 'c0000000-0000-0000-0000-000000000001'`,
    );
    expect(c.rows[0].line_id).toBe("b0000000-0000-0000-0000-000000000001");
    expect(c.rows[0].area).toBeNull();
  });

  it("volver a correr 103 con la linea ya con area no cambia el area de los chats antiguos (Ruling V)", async () => {
    await db.exec(`UPDATE whatsapp_config SET area = 'ventas' WHERE phone_number_id = 'PN-1'`);
    try {
      await db.exec(sql("103_whatsapp_lineas"));
      const c = await db.query<{ area: string | null }>(
        `SELECT area FROM conversations WHERE id = 'c0000000-0000-0000-0000-000000000001'`,
      );
      expect(c.rows[0].area).toBeNull();
    } finally {
      await db.exec(`UPDATE whatsapp_config SET area = NULL WHERE phone_number_id = 'PN-1'`);
    }
  });

  it("disconnected_at existe y es NULL por defecto (desconexion suave de lineas)", async () => {
    const r = await db.query<{ disconnected_at: string | null }>(
      `SELECT disconnected_at FROM whatsapp_config WHERE phone_number_id = 'PN-1'`,
    );
    expect(r.rows[0].disconnected_at).toBeNull();
  });

  it("(a) permite dos lineas de la misma cuenta con distinto phone_number_id", async () => {
    await db.exec(`INSERT INTO whatsapp_config(user_id, account_id, phone_number_id, access_token, line_name, area)
      VALUES ('${U.owner}', '${ACCT}', 'PN-2', 'tok', 'Legal', 'legal')`);
    const r = await db.query(`SELECT 1 FROM whatsapp_config WHERE account_id = '${ACCT}'`);
    expect(r.rows).toHaveLength(2);
  });

  it("(b) rechaza el mismo phone_number_id en dos filas", async () => {
    await expect(
      db.exec(`INSERT INTO whatsapp_config(user_id, account_id, phone_number_id, access_token)
        VALUES ('${U.owner}', '${ACCT}', 'PN-2', 'tok')`),
    ).rejects.toThrow(/whatsapp_config_phone_number_id_key|duplicate/i);
  });

  it("(c) solo una linea principal por cuenta", async () => {
    await expect(
      db.exec(`INSERT INTO whatsapp_config(user_id, account_id, phone_number_id, access_token, is_primary)
        VALUES ('${U.owner}', '${ACCT}', 'PN-3', 'tok', true)`),
    ).rejects.toThrow(/whatsapp_config_one_primary|duplicate/i);
  });

  it("el area de la linea solo admite los valores validos (incluye postventa)", async () => {
    await db.exec(`INSERT INTO whatsapp_config(user_id, account_id, phone_number_id, access_token, area)
      VALUES ('${U.owner}', '${ACCT}', 'PN-4', 'tok', 'postventa')`);
    await expect(
      db.exec(`INSERT INTO whatsapp_config(user_id, account_id, phone_number_id, access_token, area)
        VALUES ('${U.owner}', '${ACCT}', 'PN-5', 'tok', 'inventada')`),
    ).rejects.toThrow(/check/i);
  });

  it("(d) profiles.area y la invitacion aceptan postventa; conservan los valores previos", async () => {
    await db.exec(`UPDATE profiles SET area = 'postventa' WHERE user_id = '${U.agente}'`);
    await db.exec(`UPDATE profiles SET area = NULL WHERE user_id = '${U.agente}'`);
    await db.exec(`UPDATE profiles SET area = 'administracion' WHERE user_id = '${U.agente}'`);
    await db.exec(`UPDATE profiles SET area = NULL WHERE user_id = '${U.agente}'`);
    await expect(db.exec(`UPDATE profiles SET area = 'inventada' WHERE user_id = '${U.agente}'`)).rejects.toThrow(/check/i);
    await db.exec(`INSERT INTO account_invitations(account_id, role, area) VALUES ('${ACCT}', 'agent', 'postventa')`);
    await db.exec(`INSERT INTO account_invitations(account_id, role, area) VALUES ('${ACCT}', 'agent', 'promueve')`);
    await db.exec(`INSERT INTO account_invitations(account_id, role, area) VALUES ('${ACCT}', 'agent', NULL)`);
    await expect(
      db.exec(`INSERT INTO account_invitations(account_id, role, area) VALUES ('${ACCT}', 'admin', 'promueve')`),
    ).rejects.toThrow(/check/i);
  });

  it("set_member_area acepta postventa y sigue rechazando areas invalidas", async () => {
    await db.exec(`SELECT set_config('request.jwt.claim.sub', '${U.owner}', false)`);
    await db.exec(`SELECT set_member_area('${U.agente}', 'postventa')`);
    let r = await db.query<{ area: string }>(`SELECT area FROM profiles WHERE user_id = '${U.agente}'`);
    expect(r.rows[0].area).toBe("postventa");
    await db.exec(`SELECT set_member_area('${U.agente}', 'administracion')`);
    await expect(db.exec(`SELECT set_member_area('${U.agente}', 'inventada')`)).rejects.toThrow(/Unknown area: inventada/);
    await db.exec(`SELECT set_member_area('${U.agente}', NULL)`);
    r = await db.query<{ area: string }>(`SELECT area FROM profiles WHERE user_id = '${U.agente}'`);
    expect(r.rows[0].area).toBeNull();
  });

  it("conversations.line_id se pone en NULL si se borra la linea", async () => {
    await db.exec(`INSERT INTO whatsapp_config(id, user_id, account_id, phone_number_id, access_token)
      VALUES ('b0000000-0000-0000-0000-0000000000f1', '${U.owner}', '${ACCT}', 'PN-DEL', 'tok')`);
    await db.exec(`INSERT INTO conversations(id, account_id, line_id)
      VALUES ('c0000000-0000-0000-0000-0000000000f1', '${ACCT}', 'b0000000-0000-0000-0000-0000000000f1')`);
    await db.exec(`DELETE FROM whatsapp_config WHERE id = 'b0000000-0000-0000-0000-0000000000f1'`);
    const r = await db.query<{ line_id: string | null }>(
      `SELECT line_id FROM conversations WHERE id = 'c0000000-0000-0000-0000-0000000000f1'`,
    );
    expect(r.rows[0].line_id).toBeNull();
  });

  describe("(e) can_access_conversation(cuenta, asignado, area)", () => {
    it("owner y admin sin area ven todo, con o sin restriccion de la cuenta", async () => {
      for (const restringido of [false, true]) {
        await setRestringido(restringido);
        for (const area of ["legal", "cobranzas", null]) {
          expect(await puede(U.owner, U.agente, area)).toBe(true);
          expect(await puede(U.adminSinArea, U.agente, area)).toBe(true);
        }
      }
    });

    it("el usuario del area gerencia ve todo", async () => {
      await setRestringido(false);
      for (const area of ["legal", "cobranzas", "postventa", null]) {
        expect(await puede(U.gerencia, null, area)).toBe(true);
      }
    });

    it("el usuario del area legal ve legal y no cobranzas", async () => {
      await setRestringido(false);
      expect(await puede(U.legal, null, "legal")).toBe(true);
      expect(await puede(U.legal, null, "cobranzas")).toBe(false);
      expect(await puede(U.agenteLegal, null, "legal")).toBe(true);
      expect(await puede(U.agenteLegal, null, "cobranzas")).toBe(false);
    });

    it("sin area en la conversacion todo queda como hoy", async () => {
      await setRestringido(false);
      expect(await puede(U.agente, null, null)).toBe(true);
      await setRestringido(true);
      expect(await puede(U.agente, null, null)).toBe(false);
    });

    it("agent con agents_see_only_assigned ve solo lo asignado", async () => {
      await setRestringido(true);
      expect(await puede(U.agente, U.agente, null)).toBe(true);
      expect(await puede(U.agente, U.owner, null)).toBe(false);
      expect(await puede(U.agenteLegal, U.owner, null)).toBe(false);
      expect(await puede(U.agenteLegal, U.agenteLegal, "legal")).toBe(true);
    });

    it("un agente sin area no ve una conversacion de un area que no es suya", async () => {
      await setRestringido(false);
      expect(await puede(U.agente, null, "legal")).toBe(false);
    });

    it("cuenta restringida (tipo Golden): con area, el admin del area ve todo y el agente solo lo suyo", async () => {
      await db.exec(`UPDATE accounts SET name = 'Golden Habitat'`);
      await setRestringido(true);
      await db.exec(`UPDATE profiles SET area = 'cobranzas' WHERE user_id = '${U.agente}'`);
      try {
        // gerencia y dueno ven una conversacion legal sin asignar
        expect(await puede(U.gerencia, null, "legal")).toBe(true);
        expect(await puede(U.owner, null, "legal")).toBe(true);
        // admin de legal ve la conversacion legal sin asignar o ajena
        expect(await puede(U.legal, null, "legal")).toBe(true);
        expect(await puede(U.legal, U.owner, "legal")).toBe(true);
        // agente de legal (Ruling T): solo la asignada a el, como en 055
        expect(await puede(U.agenteLegal, null, "legal")).toBe(false);
        expect(await puede(U.agenteLegal, U.owner, "legal")).toBe(false);
        expect(await puede(U.agenteLegal, U.agenteLegal, "legal")).toBe(true);
        // agente de cobranzas no
        expect(await puede(U.agente, null, "legal")).toBe(false);
        expect(await puede(U.agente, U.owner, "legal")).toBe(false);
        // pero si le esta asignada, la ve
        expect(await puede(U.agente, U.agente, "legal")).toBe(true);
        // el area no abre lo de otra area
        expect(await puede(U.legal, null, "cobranzas")).toBe(false);
        // area NULL en cuenta restringida: exactamente como antes (055)
        expect(await puede(U.agenteLegal, null, null)).toBe(false);
        expect(await puede(U.agenteLegal, U.agenteLegal, null)).toBe(true);
        expect(await puede(U.legal, null, null)).toBe(false);
        expect(await puede(U.legal, U.agenteLegal, null)).toBe(true);
        expect(await puede(U.gerencia, null, null)).toBe(false);
        expect(await puede(U.adminSinArea, null, null)).toBe(true);
        expect(await puede(U.owner, U.agente, null)).toBe(true);
      } finally {
        await db.exec(`UPDATE profiles SET area = NULL WHERE user_id = '${U.agente}'`);
        await db.exec(`UPDATE accounts SET name = 'Cuenta'`);
        await setRestringido(false);
      }
    });

    it("la sobrecarga de 2 argumentos sigue funcionando (politicas vigentes)", async () => {
      await setRestringido(false);
      await db.exec(`SELECT set_config('request.jwt.claim.sub', '${U.agente}', false)`);
      const r = await db.query<{ ok: boolean }>(`SELECT can_access_conversation($1::uuid, NULL::uuid) AS ok`, [ACCT]);
      expect(r.rows[0].ok).toBe(true);
    });
  });

  it("las politicas conversations_select y messages_select usan el area de la conversacion", async () => {
    await setRestringido(false);
    await db.exec(`
      INSERT INTO conversations(id, account_id, area) VALUES
        ('c0000000-0000-0000-0000-0000000000a1', '${ACCT}', 'legal'),
        ('c0000000-0000-0000-0000-0000000000a2', '${ACCT}', 'cobranzas');
      INSERT INTO messages(id, conversation_id) VALUES
        ('d0000000-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-0000000000a1'),
        ('d0000000-0000-0000-0000-0000000000a2', 'c0000000-0000-0000-0000-0000000000a2');
      SET ROLE authenticated;
      SELECT set_config('request.jwt.claim.sub', '${U.agenteLegal}', false);
    `);
    const c = await db.query<{ id: string }>(
      `SELECT id FROM conversations WHERE id IN ('c0000000-0000-0000-0000-0000000000a1','c0000000-0000-0000-0000-0000000000a2')`,
    );
    const m = await db.query<{ id: string }>(`SELECT id FROM messages`);
    await db.exec(`RESET ROLE`);
    expect(c.rows.map((r) => r.id)).toEqual(["c0000000-0000-0000-0000-0000000000a1"]);
    expect(m.rows.map((r) => r.id)).toEqual(["d0000000-0000-0000-0000-0000000000a1"]);
  });

  // C1 / Ruling T: cuenta restringida con reparto automatico (Golden).
  describe("cuenta restringida: area de la linea y reparto (assign_new_conversation de 103)", () => {
    const V = {
      jefe: "00000000-0000-0000-0000-0000000000b1",
      asesorA: "00000000-0000-0000-0000-0000000000b2",
      asesorB: "00000000-0000-0000-0000-0000000000b3",
      cobrador: "00000000-0000-0000-0000-0000000000b4",
    };
    const CONTACTO_CON_PLAN = "e0000000-0000-0000-0000-000000000001";
    const CONTACTO_NUEVO = "e0000000-0000-0000-0000-000000000002";

    async function asignadoAl(area: string | null, contacto: string): Promise<string | null> {
      await db.exec(`SELECT set_config('request.jwt.claim.sub', '', false)`); // webhook: sin auth.uid()
      const r = await db.query<{ assigned_agent_id: string | null }>(
        `INSERT INTO conversations(account_id, contact_id, area) VALUES ($1, $2, $3) RETURNING assigned_agent_id`,
        [ACCT, contacto, area],
      );
      return r.rows[0].assigned_agent_id;
    }

    it("prepara la cuenta: jefe de ventas, dos asesores, un cobrador; trigger como 079", async () => {
      await db.exec(`
        INSERT INTO auth.users(id, email) VALUES
          ('${V.jefe}', 'j@t'), ('${V.asesorA}', 'aa@t'), ('${V.asesorB}', 'ab@t'), ('${V.cobrador}', 'c@t');
        INSERT INTO profiles(user_id, account_id, account_role, area) VALUES
          ('${V.jefe}', '${ACCT}', 'admin', 'ventas'),
          ('${V.asesorA}', '${ACCT}', 'agent', 'ventas'),
          ('${V.asesorB}', '${ACCT}', 'agent', 'ventas'),
          ('${V.cobrador}', '${ACCT}', 'agent', 'cobranzas');
        INSERT INTO payment_plans(contact_id, status) VALUES ('${CONTACTO_CON_PLAN}', 'activo');
        UPDATE accounts SET agents_see_only_assigned = true, auto_assign_new_conversations = true;
        CREATE TRIGGER assign_new_conversation BEFORE INSERT ON conversations
          FOR EACH ROW WHEN (current_setting('wio.coexistence_sync', true) IS DISTINCT FROM 'on')
          EXECUTE FUNCTION assign_new_conversation();
      `);
    });

    it("escenario 1: un asesor de ventas no ve el chat de ventas de otro asesor", async () => {
      expect(await puede(V.asesorA, V.asesorB, "ventas")).toBe(false);
      expect(await puede(V.asesorA, null, "ventas")).toBe(false);
      expect(await puede(V.asesorB, V.asesorB, "ventas")).toBe(true);
      // el jefe de ventas (admin del area) ve todo ventas
      expect(await puede(V.jefe, V.asesorB, "ventas")).toBe(true);
      expect(await puede(V.jefe, null, "ventas")).toBe(true);
      // en una cuenta sin restriccion, el area si abre los chats del area
      await setRestringido(false);
      try {
        expect(await puede(V.asesorA, V.asesorB, "ventas")).toBe(true);
      } finally {
        await setRestringido(true);
      }
    });

    it("escenario 2: un chat de Legal se asigna dentro de Legal, nunca a ventas ni cobranzas", async () => {
      const elegido = await asignadoAl("legal", CONTACTO_CON_PLAN);
      expect([U.legal, U.agenteLegal]).toContain(elegido);
      for (const u of [V.jefe, V.asesorA, V.cobrador]) {
        expect(await puede(u, elegido, "legal")).toBe(false);
      }
    });

    it("area sin nadie: el chat queda sin asignar (no cae a pick_account_agent)", async () => {
      expect(await asignadoAl("marketing", CONTACTO_NUEVO)).toBeNull();
    });

    it("area ventas: lo recibe primero el jefe de ventas", async () => {
      expect(await asignadoAl("ventas", CONTACTO_CON_PLAN)).toBe(V.jefe);
    });

    it("area NULL: exactamente como 062 (plan -> cobranzas; si no, jefe de ventas; sin nadie -> reparto general)", async () => {
      expect(await asignadoAl(null, CONTACTO_CON_PLAN)).toBe(V.cobrador);
      expect(await asignadoAl(null, CONTACTO_NUEVO)).toBe(V.jefe);
      await db.exec(`UPDATE profiles SET area = NULL WHERE user_id = '${V.cobrador}'`);
      try {
        expect(await asignadoAl(null, CONTACTO_CON_PLAN)).toBe("00000000-0000-0000-0000-0000000000ff");
      } finally {
        await db.exec(`UPDATE profiles SET area = 'cobranzas' WHERE user_id = '${V.cobrador}'`);
      }
    });
  });
});
