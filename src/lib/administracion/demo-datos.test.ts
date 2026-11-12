import { describe, expect, it } from "vitest";

import { resumenPorValidar } from "./conciliacion";
import { estadoCuentaDemo, MES_DEMO } from "./demo-datos";
import { resumirMovimientos } from "./estado-cuenta";

describe("datos de la demostración de Administración", () => {
  const d = estadoCuentaDemo();

  it("todo cae en el mes de la demo y viene ordenado por fecha", () => {
    expect(d.movimientos.every((m) => m.fecha.startsWith(MES_DEMO))).toBe(true);
    const horas = d.movimientos.map((m) => m.fechaHora);
    expect([...horas].sort()).toEqual(horas);
  });

  it("muestra los cuatro estados, como la app", () => {
    const estados = new Set(d.movimientos.map((m) => m.estado));
    expect([...estados].sort()).toEqual(["conciliado", "no_es_cuota", "por_conciliar", "revisar"]);
  });

  it("cada conciliado apunta a un pago que existe, no anulado, del mismo monto, y ninguno se repite", () => {
    const conc = d.movimientos.filter((m) => m.estado === "conciliado");
    expect(conc.length).toBeGreaterThan(3);
    const ids = conc.map((m) => m.paymentId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of conc) {
      const pago = d.pagos.find((x) => x.id === m.paymentId);
      expect(pago, m.id).toBeDefined();
      expect(pago!.voided).toBe(false);
      expect(pago!.amount).toBe(m.deposito);
    }
  });

  it("hay pagos del ERP sin depósito y depósitos sin pago", () => {
    const r = resumenPorValidar(d.movimientos.map((m) => ({ id: m.id, fecha: m.fecha, deposito: m.deposito, estado: m.estado, paymentId: m.paymentId })), d.pagos);
    expect(r.pagosSinDeposito.length).toBeGreaterThan(0);
    expect(r.depositosSinPago.length).toBeGreaterThan(0);
    expect(r.pagosSinDeposito.every((x) => !x.voided)).toBe(true);
  });

  it("el resumen suma y los datos son claramente inventados", () => {
    const s = resumirMovimientos(d.movimientos);
    expect(s.abonos).toBeGreaterThan(0);
    expect(s.abonos).toBeLessThan(s.totalDepositos);
    expect(JSON.stringify(d)).not.toMatch(/108532321000067245/);
  });
});
