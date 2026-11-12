import { describe, expect, it } from "vitest";

import { conciliar, diasEntre, resumenPorValidar, type MovimientoConciliable, type PagoErp } from "./conciliacion";

const mov = (id: string, fecha: string, deposito: number, extra: Partial<MovimientoConciliable> = {}): MovimientoConciliable => ({
  id, fecha, deposito, estado: "por_conciliar", paymentId: null, ...extra,
});
const pago = (id: string, paidOn: string, amount: number, extra: Partial<PagoErp> = {}): PagoErp => ({
  id, paidOn, amount, voided: false, ...extra,
});

describe("diasEntre", () => {
  it("cuenta días calendario, también entre meses y años", () => {
    expect(diasEntre("2026-10-01", "2026-10-03")).toBe(2);
    expect(diasEntre("2026-10-31", "2026-11-01")).toBe(1);
    expect(diasEntre("2026-12-31", "2027-01-01")).toBe(1);
    expect(diasEntre("2026-10-05", "2026-10-03")).toBe(-2);
  });
});

describe("conciliar", () => {
  it("un solo candidato (mismo monto, mismo día) = conciliado", () => {
    const r = conciliar([mov("m1", "2026-10-05", 500)], [pago("p1", "2026-10-05", 500)]);
    expect(r).toEqual([{ movementId: "m1", estado: "conciliado", paymentId: "p1", candidatos: ["p1"] }]);
  });

  it("acepta hasta 2 días de diferencia en cualquier sentido, no 3", () => {
    const pagos = [pago("a", "2026-10-03", 100), pago("b", "2026-10-07", 100), pago("c", "2026-10-08", 100)];
    expect(conciliar([mov("m", "2026-10-05", 100)], [pagos[0]])[0].estado).toBe("conciliado");
    expect(conciliar([mov("m", "2026-10-05", 100)], [pagos[1]])[0].estado).toBe("conciliado");
    expect(conciliar([mov("m", "2026-10-05", 100)], [pagos[2]])[0].estado).toBe("por_conciliar");
  });

  it("el monto debe ser exacto al centavo", () => {
    expect(conciliar([mov("m", "2026-10-05", 100.1)], [pago("p", "2026-10-05", 100.11)])[0].estado).toBe("por_conciliar");
    expect(conciliar([mov("m", "2026-10-05", 0.3)], [pago("p", "2026-10-05", 0.1 + 0.2)])[0].estado).toBe("conciliado");
  });

  it("varios candidatos = revisar, sin elegir uno", () => {
    const r = conciliar([mov("m", "2026-10-05", 500)], [pago("p1", "2026-10-04", 500), pago("p2", "2026-10-06", 500)]);
    expect(r[0]).toEqual({ movementId: "m", estado: "revisar", paymentId: null, candidatos: ["p1", "p2"] });
  });

  it("un pago que reclaman dos depósitos no se asigna a ninguno: ambos a revisar", () => {
    const r = conciliar([mov("m1", "2026-10-05", 500), mov("m2", "2026-10-05", 500)], [pago("p1", "2026-10-05", 500)]);
    expect(r.map((x) => x.estado)).toEqual(["revisar", "revisar"]);
    expect(r.every((x) => x.paymentId === null)).toBe(true);
  });

  it("dos depósitos y dos pagos iguales: cada depósito ve dos candidatos, a revisar", () => {
    const r = conciliar(
      [mov("m1", "2026-10-05", 500), mov("m2", "2026-10-05", 500)],
      [pago("p1", "2026-10-05", 500), pago("p2", "2026-10-05", 500)],
    );
    expect(r.map((x) => x.estado)).toEqual(["revisar", "revisar"]);
  });

  it("ignora pagos anulados y los que ya están enlazados a otro movimiento", () => {
    const r = conciliar(
      [mov("m", "2026-10-05", 500), mov("ya", "2026-10-01", 80, { estado: "conciliado", paymentId: "p2" })],
      [pago("p1", "2026-10-05", 500, { voided: true }), pago("p2", "2026-10-05", 500)],
    );
    expect(r).toEqual([{ movementId: "m", estado: "por_conciliar", paymentId: null, candidatos: [] }]);
  });

  it("solo toca depósitos por conciliar o a revisar: lo conciliado, lo que no es cuota y los retiros se dejan", () => {
    const r = conciliar(
      [
        mov("a", "2026-10-05", 500, { estado: "conciliado", paymentId: "p0" }),
        mov("b", "2026-10-05", 500, { estado: "no_es_cuota" }),
        mov("c", "2026-10-05", 0),
        mov("d", "2026-10-05", 500, { estado: "revisar" }),
      ],
      [pago("p1", "2026-10-05", 500)],
    );
    expect(r.map((x) => x.movementId)).toEqual(["d"]);
    expect(r[0].estado).toBe("conciliado");
  });

  it("sin candidatos queda por conciliar", () => {
    expect(conciliar([mov("m", "2026-10-05", 500)], [])[0]).toEqual({ movementId: "m", estado: "por_conciliar", paymentId: null, candidatos: [] });
  });
});

describe("resumenPorValidar", () => {
  it("separa depósitos sin pago del ERP y pagos del ERP sin depósito", () => {
    const movs = [
      mov("m1", "2026-10-05", 500, { estado: "conciliado", paymentId: "p1" }),
      mov("m2", "2026-10-06", 200),
      mov("m3", "2026-10-06", 90, { estado: "revisar" }),
      mov("m4", "2026-10-06", 70, { estado: "no_es_cuota" }),
    ];
    const pagos = [pago("p1", "2026-10-05", 500), pago("p2", "2026-10-07", 300), pago("p3", "2026-10-07", 10, { voided: true })];
    const r = resumenPorValidar(movs, pagos);
    expect(r.depositosSinPago.map((m) => m.id)).toEqual(["m2", "m3"]);
    expect(r.pagosSinDeposito.map((p) => p.id)).toEqual(["p2"]);
    expect(r.faltaConciliar).toBe(2);
  });
});
