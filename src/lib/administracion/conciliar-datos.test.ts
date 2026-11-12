import { describe, expect, it } from "vitest";

import { conciliarDatos } from "./conciliar-datos";
import type { MovimientoGuardado, PagoVista } from "./tipos";

const mov = (id: string, fecha: string, deposito: number, estado: MovimientoGuardado["estado"] = "por_conciliar"): MovimientoGuardado => ({
  id, fechaHora: `${fecha}T12:00:00-05:00`, fecha, descripcion: "x", tipo: "interbancaria", propio: false,
  deposito, retiro: 0, saldo: null, agencia: null, estado, paymentId: null, nota: null,
});
const pago = (id: string, paidOn: string, amount: number): PagoVista => ({ id, paidOn, amount, voided: false, moneda: "PEN", cliente: null, lote: null, cuota: null, metodo: null });

function fake() {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return { calls, client: { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: (args.p_items as unknown[]).length, error: null }; } } };
}

describe("conciliarDatos", () => {
  it("guarda lo conciliado y lo que hay que revisar, y devuelve los conteos", async () => {
    const f = fake();
    const r = await conciliarDatos(f.client, {
      movimientos: [mov("m1", "2026-10-05", 100), mov("m2", "2026-10-05", 200), mov("m3", "2026-10-05", 300)],
      pagos: [pago("p1", "2026-10-05", 100), pago("p2", "2026-10-05", 200), pago("p2b", "2026-10-06", 200)],
    });
    expect(r).toEqual({ ok: true, data: { conciliados: 1, revisar: 1 } });
    expect(f.calls[0].args.p_items).toEqual([
      { movement_id: "m1", estado: "conciliado", payment_id: "p1" },
      { movement_id: "m2", estado: "revisar", payment_id: null },
    ]);
  });
  it("no reescribe un 'revisar' que sigue igual", async () => {
    const f = fake();
    const r = await conciliarDatos(f.client, {
      movimientos: [mov("m2", "2026-10-05", 200, "revisar")],
      pagos: [pago("p2", "2026-10-05", 200), pago("p2b", "2026-10-06", 200)],
    });
    expect(r).toEqual({ ok: true, data: { conciliados: 0, revisar: 1 } });
    expect(f.calls).toHaveLength(0);
  });
  it("devuelve el error de la base tal cual", async () => {
    const client = { rpc: async () => ({ data: null, error: { code: "42501", message: "Sin acceso" } }) };
    const r = await conciliarDatos(client, { movimientos: [mov("m1", "2026-10-05", 100)], pagos: [pago("p1", "2026-10-05", 100)] });
    expect(r).toEqual({ ok: false, missing093: false, message: "Sin acceso" });
  });
});
