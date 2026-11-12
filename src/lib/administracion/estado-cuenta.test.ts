import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { ENCABEZADO_ESTADO, FILAS_ESTADO_INVENTADAS, TOTALES_FIXTURE } from "./fixture-estado";
import { clasificarMovimiento, parsearFilas, resumirMovimientos } from "./estado-cuenta";
import { leerArchivoXls } from "./leer-xls";

const conEncabezado = () => [[...ENCABEZADO_ESTADO], ...FILAS_ESTADO_INVENTADAS];

describe("clasificarMovimiento", () => {
  it("reconoce los textos de la Caja Ica", () => {
    const c = (d: string, dep = 10, ret = 0) => clasificarMovimiento(d, dep, ret).tipo;
    expect(c("TRANS. INTER. INME. (CCE)")).toBe("interbancaria");
    expect(c("Depósito conv. cobranza")).toBe("convenio");
    expect(c("CONVENIOS (ABONO AHO) APP MOVIL")).toBe("app");
    expect(c("Depósito efectivo")).toBe("efectivo");
  });
  it("los cargos de la empresa son comisión", () => {
    for (const d of ["Cargo conv. cobranza", "CONVENIOS COM (CARGO AHO) APP MOVIL", "Ccprop-cargo conv cobranza", "Cobro de ITF cargo cuenta", "Cobro ITF cargo cuenta servicio cobranza", "COM TRANSF INTERB INMED ORD CCE HB", "Comisión traslado de fondos"]) {
      expect(clasificarMovimiento(d, 0, 1.5).tipo).toBe("comision");
    }
  });
  it("una salida de fondos no es comisión", () => {
    expect(clasificarMovimiento("TRANSF INTERB INMED ORD CCE HB", 0, 15000).tipo).toBe("otro");
  });
  it("lo que no se reconoce queda en otro y el traspaso entre cuentas propias se marca", () => {
    expect(clasificarMovimiento("Depósito CCAKAS", 310, 0)).toEqual({ tipo: "otro", propio: false });
    expect(clasificarMovimiento("Ccprop-depósito conv cobranza", 200, 0).tipo).toBe("otro");
    expect(clasificarMovimiento("DEPOSITO TERCEROS AHORROS - CC PROPIOS", 370, 0)).toEqual({ tipo: "otro", propio: true });
  });
  it("insensible a mayúsculas y tildes", () => {
    expect(clasificarMovimiento("DEPOSITO CONV. COBRANZA", 5, 0).tipo).toBe("convenio");
    expect(clasificarMovimiento("depósito EFECTIVO", 5, 0).tipo).toBe("efectivo");
  });
});

describe("parsearFilas", () => {
  it("lee fecha dd/mm/aaaa hh:mm:ss como hora de Lima y devuelve montos positivos", () => {
    const r = parsearFilas(conEncabezado(), "Estado de Cuenta - 108532321000067245.xls");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cuenta).toBe("108532321000067245");
    expect(r.movimientos).toHaveLength(TOTALES_FIXTURE.filas);
    const m = r.movimientos[0];
    expect(m.fechaHora).toBe("2026-10-01T07:11:20-05:00");
    expect(m.fecha).toBe("2026-10-01");
    expect(m.deposito).toBe(300);
    expect(m.tipo).toBe("interbancaria");
    expect(m.agencia).toBe("Libertad");
    const cargo = r.movimientos[3];
    expect(cargo.retiro).toBe(1.5);
    expect(cargo.deposito).toBe(0);
    expect(cargo.saldo).toBe(11149);
    expect(r.periodo).toEqual({ desde: "2026-10-01", hasta: "2026-10-31" });
  });

  it("el resumen da los totales por tipo", () => {
    const r = parsearFilas(conEncabezado());
    if (!r.ok) throw new Error(r.error);
    const s = r.resumen;
    expect(s.totalDepositos).toBe(TOTALES_FIXTURE.totalDepositos);
    expect(s.abonos).toBe(TOTALES_FIXTURE.abonos);
    expect(s.porTipo.convenio).toMatchObject({ n: 2, monto: 800 });
    expect(s.porTipo.interbancaria).toMatchObject({ n: 2, monto: 750.5 });
    expect(s.porTipo.app).toMatchObject({ n: 2, monto: 600.25 });
    expect(s.porTipo.efectivo).toMatchObject({ n: 1, monto: 600 });
    expect(s.porTipo.otro.n).toBe(4);
    expect(s.comisiones).toEqual(TOTALES_FIXTURE.comisiones);
  });

  it("la huella es estable, distingue filas iguales de un mismo archivo y no cambia al volver a leer", () => {
    const filas = conEncabezado();
    filas.push([...filas[1]]); // movimiento idéntico, mismo segundo
    const a = parsearFilas(filas);
    const b = parsearFilas(filas);
    if (!a.ok || !b.ok) throw new Error("lectura");
    const h = a.movimientos.map((m) => m.huella);
    expect(new Set(h).size).toBe(h.length);
    expect(h).toEqual(b.movimientos.map((m) => m.huella));
  });

  it("estado inicial: comisiones, salidas y traspasos propios no son cuotas", () => {
    const r = parsearFilas(conEncabezado());
    if (!r.ok) throw new Error(r.error);
    const por = (d: string) => r.movimientos.filter((m) => m.descripcion === d);
    expect(por("TRANS. INTER. INME. (CCE)").every((m) => m.estado === "por_conciliar")).toBe(true);
    expect(por("Cargo conv. cobranza").every((m) => m.estado === "no_es_cuota")).toBe(true);
    expect(por("TRANSF INTERB INMED ORD CCE HB")[0].estado).toBe("no_es_cuota");
    expect(por("DEPOSITO TERCEROS AHORROS - CC PROPIOS")[0].estado).toBe("no_es_cuota");
    expect(por("Capitalización intereses activa")[0].estado).toBe("no_es_cuota");
    expect(por("Depósito CCAKAS")[0].estado).toBe("por_conciliar");
  });

  it("acepta números como texto, con coma de miles", () => {
    const r = parsearFilas([[...ENCABEZADO_ESTADO], ["02/10/2026 08:00:00", "Depósito efectivo", "1,234.50", "0", "5,000.00", "5,000.00", "Ica"]]);
    if (!r.ok) throw new Error(r.error);
    expect(r.movimientos[0].deposito).toBe(1234.5);
    expect(r.movimientos[0].saldo).toBe(5000);
  });

  it("avisa en español si no es un estado de cuenta", () => {
    const r = parsearFilas([["Nombre", "Edad"], ["Ana", 3]]);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("estado de cuenta") });
    expect(parsearFilas([])).toEqual({ ok: false, error: expect.stringContaining("vacío") });
  });

  it("una fecha mala frena la lectura con el número de fila", () => {
    const r = parsearFilas([[...ENCABEZADO_ESTADO], ["ayer", "Depósito efectivo", 10, 0, 10, 10, "Ica"]]);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("Fila 2") });
  });

  it("ignora filas vacías al final", () => {
    const r = parsearFilas([...conEncabezado(), [null, null, null, null, null, null, null]]);
    if (!r.ok) throw new Error(r.error);
    expect(r.movimientos).toHaveLength(TOTALES_FIXTURE.filas);
  });
});

describe("resumirMovimientos (filas ya guardadas)", () => {
  it("suma por tipo en centavos sin arrastrar error de coma flotante", () => {
    const s = resumirMovimientos([
      { tipo: "app", deposito: 0.1, retiro: 0, propio: false },
      { tipo: "app", deposito: 0.2, retiro: 0, propio: false },
      { tipo: "comision", deposito: 0, retiro: 0.3, propio: false },
    ]);
    expect(s.porTipo.app.monto).toBe(0.3);
    expect(s.comisiones.monto).toBe(0.3);
  });
});

describe("leerArchivoXls (BIFF real generado en la prueba)", () => {
  it("lee un .xls y da lo mismo que las filas crudas", async () => {
    const ws = XLSX.utils.aoa_to_sheet(conEncabezado());
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Estado de cuenta");
    const bytes = XLSX.write(wb, { bookType: "biff8", type: "array" }) as ArrayBuffer;
    // BIFF8 empieza con la firma de documento compuesto D0 CF 11 E0.
    expect(Array.from(new Uint8Array(bytes).slice(0, 4))).toEqual([0xd0, 0xcf, 0x11, 0xe0]);
    const r = await leerArchivoXls(bytes, "Estado de Cuenta - 108532321000067245.xls");
    if (!r.ok) throw new Error(r.error);
    expect(r.movimientos).toHaveLength(TOTALES_FIXTURE.filas);
    expect(r.resumen.abonos).toBe(TOTALES_FIXTURE.abonos);
    expect(r.movimientos[0].fechaHora).toBe("2026-10-01T07:11:20-05:00");
  });

  it("un archivo que no es Excel da un mensaje claro", async () => {
    const r = await leerArchivoXls(new TextEncoder().encode("hola").buffer as ArrayBuffer, "x.xls");
    expect(r.ok).toBe(false);
  });
});
