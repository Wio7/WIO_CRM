import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// PostgreSQL desechable en memoria: aplica 088 y luego 090 (dos veces) y
// comprueba que el candado es ahora (solicitud_id, evento).
const db = new PGlite();
const sql = (name: string) => readFileSync(`supabase/migrations/${name}.sql`, "utf8");

const ACC = "00000000-0000-4000-8000-0000000000a1";
const SOL = "11111111-1111-4111-8111-111111111111";
const OTRA = "22222222-2222-4222-8222-222222222222";

beforeAll(async () => {
  await db.exec(`CREATE TABLE accounts(id uuid PRIMARY KEY); INSERT INTO accounts VALUES ('${ACC}');`);
  await db.exec(sql("088_golden_separacion_avisos"));
  // Una fila de antes de la 090 (el único evento que existía era la aprobación).
  await db.exec(`INSERT INTO golden_separacion_avisos(solicitud_id, account_id) VALUES ('${SOL}', '${ACC}')`);
  await db.exec(sql("090_golden_avisos_por_evento"));
  await db.exec(sql("090_golden_avisos_por_evento"));
}, 60000);

afterAll(() => db.close());

const insertar = (id: string, evento: string) =>
  db.query("INSERT INTO golden_separacion_avisos(solicitud_id, evento, account_id) VALUES ($1, $2, $3)", [id, evento, ACC]);

describe("090: un aviso por solicitud y evento", () => {
  it("las filas anteriores quedan como 'aprobada'", async () => {
    const r = await db.query<{ evento: string }>("SELECT evento FROM golden_separacion_avisos WHERE solicitud_id = $1", [SOL]);
    expect(r.rows).toEqual([{ evento: "aprobada" }]);
  });

  it("la misma solicitud puede avisar sus tres etapas, una vez cada una", async () => {
    await insertar(SOL, "solicitada");
    await insertar(SOL, "vendida");
    await expect(insertar(SOL, "aprobada")).rejects.toMatchObject({ code: "23505" });
    await expect(insertar(SOL, "solicitada")).rejects.toMatchObject({ code: "23505" });
    await expect(insertar(SOL, "vendida")).rejects.toMatchObject({ code: "23505" });
  });

  it("rechaza eventos inventados", async () => {
    await expect(insertar(OTRA, "hackeo")).rejects.toMatchObject({ code: "23514" });
  });

  it("sin evento (insert de la 088) cuenta como 'aprobada'", async () => {
    await db.query("INSERT INTO golden_separacion_avisos(solicitud_id, account_id) VALUES ($1, $2)", [OTRA, ACC]);
    await expect(insertar(OTRA, "aprobada")).rejects.toMatchObject({ code: "23505" });
  });

  it("la clave primaria quedó en (solicitud_id, evento)", async () => {
    const r = await db.query<{ columnas: string }>(
      `SELECT string_agg(a.attname, ',' ORDER BY a.attname) AS columnas
         FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'golden_separacion_avisos'::regclass AND c.contype = 'p'`,
    );
    expect(r.rows[0].columnas).toBe("evento,solicitud_id");
  });
});
