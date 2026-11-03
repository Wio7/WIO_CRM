import { describe, expect, it } from "vitest";

import { armarDiaDeCombi, type AsientoDeCombi, type SalidaDeCombi } from "./combi";

const salida = (cambios: Partial<SalidaDeCombi> = {}): SalidaDeCombi => ({
  id: "s1",
  hora: "09:00:00",
  proyecto: "Colinas II",
  capacidad: 10,
  nota: null,
  salio_at: null,
  llego_at: null,
  visito_at: null,
  volvio_at: null,
  ...cambios,
});
const asiento = (cambios: Partial<AsientoDeCombi> = {}): AsientoDeCombi => ({
  numero: 1,
  tipo: "cliente",
  nombre: "Ana Ríos",
  telefono: "999",
  asesor_nombre: "Sara",
  asistencia: null,
  ...cambios,
});
const VIERNES = "2026-10-30";
const HORARIOS = { 5: ["09:00", "11:30", "15:30"], 0: ["10:00"] };

describe("armarDiaDeCombi", () => {
  it("da hora, proyecto, libres y pasajeros de cada salida", () => {
    const dia = armarDiaDeCombi(VIERNES, [salida()], new Map([["s1", [asiento(), asiento({ numero: 2, tipo: "asesor", nombre: "Sara" })]]]), HORARIOS);
    expect(dia.salidas[0]).toMatchObject({ hora: "09:00", proyecto: "Colinas II", ocupados: 2, libres: 8, estado: "por salir" });
    expect(dia.salidas[0].pasajeros[0]).toMatchObject({ nombre: "Ana Ríos", asesor: "Sara", telefono: "999" });
  });

  it("un horario sin salida creada queda como programado", () => {
    const dia = armarDiaDeCombi(VIERNES, [salida()], new Map(), HORARIOS);
    expect(dia.programados_sin_pasajeros).toEqual(["11:30", "15:30"]);
  });

  it("toma los horarios del día de la semana correcto en Lima", () => {
    expect(armarDiaDeCombi("2026-11-01", [], new Map(), HORARIOS).programados_sin_pasajeros).toEqual(["10:00"]);
  });

  it("sin horarios publicados no inventa ninguno", () => {
    expect(armarDiaDeCombi(VIERNES, [], new Map(), undefined).programados_sin_pasajeros).toEqual([]);
  });

  it("el estado sale de la última marca del conductor", () => {
    const estado = (c: Partial<SalidaDeCombi>) => armarDiaDeCombi(VIERNES, [salida(c)], new Map(), HORARIOS).salidas[0].estado;
    expect(estado({ salio_at: "x" })).toBe("en camino");
    expect(estado({ salio_at: "x", llego_at: "x" })).toBe("en el proyecto");
    expect(estado({ salio_at: "x", llego_at: "x", visito_at: "x" })).toBe("de regreso");
    expect(estado({ salio_at: "x", llego_at: "x", visito_at: "x", volvio_at: "x" })).toBe("ya volvió");
  });

  it("nunca da libres negativos", () => {
    const llena = Array.from({ length: 12 }, (_, i) => asiento({ numero: i + 1 }));
    const dia = armarDiaDeCombi(VIERNES, [salida()], new Map([["s1", llena]]), HORARIOS);
    expect(dia.salidas[0].libres).toBe(0);
  });
});
