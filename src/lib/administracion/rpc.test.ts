import { describe, expect, it } from "vitest";

import { ENCABEZADO_ESTADO, FILAS_ESTADO_INVENTADAS } from "./fixture-estado";
import { parsearFilas } from "./estado-cuenta";
import { armarPayloadImportacion, guardarConciliacion, importarEstadoCuenta, marcarMovimiento } from "./rpc";

type Call = { fn: string; args: Record<string, unknown> };

function fakeClient(result: { data?: unknown; error?: { code?: string; message: string } | null } = {}) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return { data: result.data ?? null, error: result.error ?? null };
      },
    },
  };
}

const lectura = () => {
  const r = parsearFilas([[...ENCABEZADO_ESTADO], ...FILAS_ESTADO_INVENTADAS], "Estado de Cuenta - 108532321000067245.xls");
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("armarPayloadImportacion", () => {
  it("arma las filas en el formato que espera import_bank_statement", () => {
    const p = armarPayloadImportacion(lectura(), "Estado de Cuenta - 108532321000067245.xls");
    expect(p).toMatchObject({
      banco: "caja_ica",
      cuenta: "108532321000067245",
      archivo: "Estado de Cuenta - 108532321000067245.xls",
      periodo_desde: "2026-10-01",
      periodo_hasta: "2026-10-31",
    });
    expect(p.filas).toHaveLength(FILAS_ESTADO_INVENTADAS.length);
    expect(p.filas[0]).toEqual({
      fecha_hora: "2026-10-01T07:11:20-05:00",
      descripcion: "TRANS. INTER. INME. (CCE)",
      tipo: "interbancaria",
      propio: false,
      deposito: 300,
      retiro: 0,
      saldo: 10300,
      agencia: "Libertad",
      huella: expect.any(String),
      estado: "por_conciliar",
    });
    expect(p.filas[3]).toMatchObject({ tipo: "comision", retiro: 1.5, estado: "no_es_cuota" });
  });
});

describe("importarEstadoCuenta", () => {
  it("llama a import_bank_statement y devuelve nuevos y duplicados", async () => {
    const f = fakeClient({ data: { import_id: "i1", filas: 19, nuevos: 15, duplicados: 4 } });
    const payload = armarPayloadImportacion(lectura(), null);
    const r = await importarEstadoCuenta(f.client, payload);
    expect(r).toEqual({ ok: true, data: { importId: "i1", filas: 19, nuevos: 15, duplicados: 4 } });
    expect(f.calls[0].fn).toBe("import_bank_statement");
    expect(f.calls[0].args).toEqual({ p_payload: payload });
  });
  it("si falta la 093 lo dice con su mensaje, sin otro intento", async () => {
    const f = fakeClient({ error: { code: "PGRST202", message: "Could not find the function" } });
    const r = await importarEstadoCuenta(f.client, armarPayloadImportacion(lectura(), null));
    expect(r).toEqual({ ok: false, missing093: true, message: expect.stringContaining("093") });
    expect(f.calls).toHaveLength(1);
  });
  it("otro error vuelve con el mensaje de la base", async () => {
    const f = fakeClient({ error: { code: "42501", message: "Sin acceso al estado de cuenta del banco" } });
    const r = await importarEstadoCuenta(f.client, armarPayloadImportacion(lectura(), null));
    expect(r).toEqual({ ok: false, missing093: false, message: "Sin acceso al estado de cuenta del banco" });
  });
});

describe("guardarConciliacion", () => {
  const res = (n: number, estado: "conciliado" | "revisar" | "por_conciliar") =>
    Array.from({ length: n }, (_, i) => ({ movementId: `m${estado}${i}`, estado, paymentId: estado === "conciliado" ? `p${i}` : null, candidatos: [] }));

  it("envía solo lo que cambia, en tandas de 500", async () => {
    const f = fakeClient({ data: 500 });
    const r = await guardarConciliacion(f.client, [...res(700, "conciliado"), ...res(300, "revisar"), ...res(50, "por_conciliar")]);
    expect(f.calls.map((c) => (c.args.p_items as unknown[]).length)).toEqual([500, 500]);
    expect(r.ok).toBe(true);
    expect(f.calls[0].fn).toBe("set_movement_matches");
    expect((f.calls[0].args.p_items as Record<string, unknown>[])[0]).toEqual({ movement_id: "m" + "conciliado0", estado: "conciliado", payment_id: "p0" });
  });
  it("sin cambios no llama a la base", async () => {
    const f = fakeClient();
    expect(await guardarConciliacion(f.client, res(5, "por_conciliar"))).toEqual({ ok: true, data: 0 });
    expect(f.calls).toHaveLength(0);
  });
  it("se detiene en el primer error", async () => {
    const f = fakeClient({ error: { code: "23505", message: "Ese pago ya está enlazado a otro movimiento del banco" } });
    const r = await guardarConciliacion(f.client, res(900, "conciliado"));
    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(1);
  });
});

describe("marcarMovimiento", () => {
  it("llama a set_movement_match con parámetros p_*", async () => {
    const f = fakeClient();
    const r = await marcarMovimiento(f.client, { movementId: "m1", estado: "conciliado", paymentId: "p1", nota: "ok" });
    expect(r).toEqual({ ok: true, data: undefined });
    expect(f.calls[0]).toEqual({ fn: "set_movement_match", args: { p_movement_id: "m1", p_estado: "conciliado", p_payment_id: "p1", p_nota: "ok" } });
    await marcarMovimiento(f.client, { movementId: "m2", estado: "no_es_cuota" });
    expect(f.calls[1].args).toEqual({ p_movement_id: "m2", p_estado: "no_es_cuota", p_payment_id: null, p_nota: null });
  });
});
