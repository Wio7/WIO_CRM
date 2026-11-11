import { describe, expect, it } from "vitest";

import { TRAMOS } from "@/lib/collections";

import { cuotasDemo, HOY_DEMO, morososDemo, PAGOS_DEL_DIA_DEMO } from "./demo-datos";
import { resumenMora } from "./resumen";

describe("datos de la demostración", () => {
  const morosos = morososDemo();
  const resumen = resumenMora(morosos);

  it("hay morosos en los cuatro tramos, para que la tarjeta muestre todo", () => {
    for (const t of TRAMOS) expect(resumen.porTramo[t].clientes, `tramo ${t}`).toBeGreaterThan(0);
  });

  it("los clientes por tramo suman los clientes en mora", () => {
    const enMora = resumen.porMoneda.reduce((n, m) => n + m.clientes, 0);
    const porTramo = TRAMOS.reduce((n, t) => n + resumen.porTramo[t].clientes, 0);
    expect(porTramo).toBe(enMora);
  });

  it("el total vencido en soles es la suma de las cuotas sin voucher", () => {
    const esperado = cuotasDemo()
      .filter((c) => c.plan?.currency === "PEN" && !c.voucher_path && c.due_date < HOY_DEMO)
      .reduce((n, c) => n + Number(c.amount), 0);
    const pen = resumen.porMoneda.find((m) => m.currency === "PEN");
    expect(pen?.monto).toBe(esperado);
  });

  it("los montos por tramo suman el total de la moneda principal", () => {
    const suma = TRAMOS.reduce((n, t) => n + resumen.porTramo[t].monto, 0);
    const principal = resumen.porMoneda.find((m) => m.currency === resumen.monedaPrincipal);
    expect(Math.round(suma * 100) / 100).toBe(principal?.monto);
  });

  it("Pedro debe una cuota y tiene otra con voucher en revisión", () => {
    const pedro = morosos.find((d) => d.name.startsWith("Pedro"));
    expect(pedro?.overdueCount).toBe(1);
    expect(pedro?.inReviewCount).toBe(1);
  });

  it("los teléfonos de la demo son ficticios (900000xxx): ningún botón contacta a alguien", () => {
    for (const c of cuotasDemo()) expect(c.plan?.contact?.phone).toMatch(/^900000\d{3}$/);
  });

  it("el reporte del día trae pagos", () => {
    expect(PAGOS_DEL_DIA_DEMO.length).toBeGreaterThan(0);
  });
});
