import { describe, expect, it } from "vitest";

import { aMovimiento, aPago } from "./tipos";

describe("aMovimiento", () => {
  it("pasa los numeric de PostgREST (texto) a número y conserva el enlace", () => {
    const m = aMovimiento({
      id: "m1", fecha_hora: "2026-10-01T12:11:20+00:00", fecha: "2026-10-01", descripcion: "Depósito efectivo",
      tipo: "efectivo", propio: false, deposito: "600.00", retiro: "0.00", saldo: "13055.75", agencia: "Libertad",
      estado: "conciliado", payment_id: "p1", nota: null,
    });
    expect(m).toMatchObject({ id: "m1", deposito: 600, retiro: 0, saldo: 13055.75, estado: "conciliado", paymentId: "p1", tipo: "efectivo" });
  });
  it("un tipo o estado desconocido no rompe la pantalla", () => {
    const m = aMovimiento({
      id: "m", fecha_hora: "2026-10-01T00:00:00Z", fecha: "2026-10-01", descripcion: "x", tipo: "nuevo", propio: false,
      deposito: 1, retiro: 0, saldo: null, agencia: null, estado: "raro", payment_id: null, nota: null,
    });
    expect(m.tipo).toBe("otro");
    expect(m.estado).toBe("revisar");
    expect(m.saldo).toBeNull();
  });
});

describe("aPago", () => {
  it("toma cliente, lote y cuota; anulado si tiene voided_at", () => {
    const p = aPago({
      id: "p1", amount: "500.00", paid_on: "2026-10-05", method: "Yape", voided_at: null,
      installment: { number: 3 }, plan: { currency: "PEN", contact: { name: "Cliente Uno" }, unit: { code: "A-12" } },
    });
    expect(p).toEqual({ id: "p1", paidOn: "2026-10-05", amount: 500, voided: false, moneda: "PEN", cliente: "Cliente Uno", lote: "A-12", cuota: 3, metodo: "Yape" });
    expect(aPago({ id: "p2", amount: 1, paid_on: "2026-10-05", method: null, voided_at: "2026-10-06T00:00:00Z", installment: null, plan: null }))
      .toMatchObject({ voided: true, moneda: "PEN", cliente: null, lote: null, cuota: null });
  });
});
