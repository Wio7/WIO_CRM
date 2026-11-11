import { describe, expect, it } from "vitest";

import type { Debtor } from "@/lib/collections";

import { resumenMora } from "./resumen";

const deudor = (over: Partial<Debtor>): Debtor => ({
  contactId: "c",
  name: "Cliente",
  phone: null,
  dni: null,
  currency: "PEN",
  units: [],
  projects: [],
  overdueCount: 1,
  overdueAmount: 100,
  oldestDue: "2026-10-01",
  daysLate: 10,
  tramo: "1-30",
  lastReminder: null,
  inReviewCount: 0,
  inReviewAmount: 0,
  worstPlan: null,
  ...over,
});

describe("resumenMora", () => {
  it("sin morosos todo es cero", () => {
    const r = resumenMora([]);
    expect(r.porMoneda).toEqual([]);
    expect(r.monedaPrincipal).toBeNull();
    expect(r.porTramo["1-30"]).toEqual({ clientes: 0, monto: 0 });
  });

  it("suma el vencido por moneda sin mezclar soles y dólares", () => {
    const r = resumenMora([
      deudor({ contactId: "a", overdueAmount: 300 }),
      deudor({ contactId: "b", overdueAmount: 200.5 }),
      deudor({ contactId: "c", currency: "USD", overdueAmount: 1000 }),
    ]);
    expect(r.porMoneda).toEqual([
      { currency: "PEN", monto: 500.5, clientes: 2 },
      { currency: "USD", monto: 1000, clientes: 1 },
    ]);
  });

  it("cuenta clientes y monto por tramo", () => {
    const r = resumenMora([
      deudor({ contactId: "a", tramo: "1-30", overdueAmount: 100 }),
      deudor({ contactId: "b", tramo: "31-60", overdueAmount: 250 }),
      deudor({ contactId: "c", tramo: "31-60", overdueAmount: 50 }),
      deudor({ contactId: "d", tramo: "90+", overdueAmount: 900 }),
    ]);
    expect(r.porTramo["31-60"]).toEqual({ clientes: 2, monto: 300 });
    expect(r.porTramo["61-90"]).toEqual({ clientes: 0, monto: 0 });
    expect(r.porTramo["90+"]).toEqual({ clientes: 1, monto: 900 });
  });

  it("no suma como mora a quien solo espera la aprobación de su voucher", () => {
    const r = resumenMora([deudor({ overdueCount: 0, overdueAmount: 0, inReviewCount: 1, inReviewAmount: 400 })]);
    expect(r.porMoneda).toEqual([]);
    expect(r.porTramo["1-30"].clientes).toBe(0);
  });

  it("el monto por tramo es solo de la moneda principal (la de más clientes)", () => {
    const r = resumenMora([
      deudor({ contactId: "a", tramo: "1-30", overdueAmount: 100 }),
      deudor({ contactId: "b", tramo: "1-30", overdueAmount: 50 }),
      deudor({ contactId: "c", currency: "USD", tramo: "1-30", overdueAmount: 9000 }),
    ]);
    expect(r.monedaPrincipal).toBe("PEN");
    expect(r.porTramo["1-30"]).toEqual({ clientes: 3, monto: 150 });
  });

  it("redondea a centavos", () => {
    const r = resumenMora([deudor({ overdueAmount: 0.1 }), deudor({ contactId: "x", overdueAmount: 0.2 })]);
    expect(r.porMoneda[0].monto).toBe(0.3);
  });
});
