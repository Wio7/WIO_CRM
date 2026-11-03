import { describe, expect, it } from "vitest";

import {
  armarActivos,
  armarRanking,
  estaEnLinea,
  indicesDeActividad,
  rangoDePeriodo,
  sumarVenta,
  ventasEnCero,
} from "./rendimiento";

const AHORA = new Date("2026-10-30T17:00:00.000Z"); // viernes 30, 12:00 en Lima

describe("rangoDePeriodo", () => {
  it("hoy va de medianoche a medianoche en Lima", () => {
    expect(rangoDePeriodo({ periodo: "hoy" }, AHORA)).toMatchObject({
      desde: "2026-10-30T05:00:00.000Z",
      hasta: "2026-10-31T05:00:00.000Z",
      diaDesde: "2026-10-30",
      diaHasta: "2026-10-30",
    });
  });

  it("a las 11 de la noche en Lima sigue siendo el mismo día", () => {
    const noche = new Date("2026-10-31T04:00:00.000Z");
    expect(rangoDePeriodo({ periodo: "hoy" }, noche).diaDesde).toBe("2026-10-30");
  });

  it("la semana empieza el lunes, como en Control", () => {
    expect(rangoDePeriodo({ periodo: "semana" }, AHORA)).toMatchObject({
      desde: "2026-10-26T05:00:00.000Z",
      hasta: "2026-11-02T05:00:00.000Z",
    });
  });

  it("el domingo pertenece a la semana que empezó el lunes anterior", () => {
    const domingo = new Date("2026-11-01T17:00:00.000Z");
    expect(rangoDePeriodo({ periodo: "semana" }, domingo).diaDesde).toBe("2026-10-26");
  });

  it("el mes va del 1 al 1, y es el periodo por defecto", () => {
    expect(rangoDePeriodo({}, AHORA)).toMatchObject({
      desde: "2026-10-01T05:00:00.000Z",
      hasta: "2026-11-01T05:00:00.000Z",
    });
  });

  it("con fechas, el último día entra completo", () => {
    expect(rangoDePeriodo({ desde: "2026-10-05", hasta: "2026-10-06" }, AHORA)).toMatchObject({
      desde: "2026-10-05T05:00:00.000Z",
      hasta: "2026-10-07T05:00:00.000Z",
    });
  });

  it("una fecha mal escrita no rompe: usa el periodo por defecto", () => {
    expect(rangoDePeriodo({ desde: "ayer" }, AHORA).diaDesde).toBe("2026-10-01");
  });
});

describe("indicesDeActividad", () => {
  // Los mismos datos dan lo mismo en golden 3d/src/lib/control.js:
  // cita vigente 3, cumplida 2 más, mensaje enviado 0.5, 100 para quien más hizo.
  it("da el mismo índice que la pantalla Control", () => {
    const r = indicesDeActividad([
      { citas: { total: 3, cumplidas: 1, canceladas: 1 }, enviados: 4 }, // 2×3 + 1×2 + 4×0.5 = 10
      { citas: { total: 1, cumplidas: 0, canceladas: 0 }, enviados: 2 }, // 3 + 1 = 4
      { citas: { total: 0, cumplidas: 0, canceladas: 0 }, enviados: 0 },
    ]);
    expect(r).toEqual([100, 40, 0]);
  });

  it("sin actividad de nadie todos quedan en cero", () => {
    expect(indicesDeActividad([{ citas: { total: 0, cumplidas: 0, canceladas: 0 }, enviados: 0 }])).toEqual([0]);
  });
});

describe("armarRanking", () => {
  const persona = (nombre: string, cantidad: number, PEN: number, indice = 0) => ({
    nombre,
    ventas: { ...ventasEnCero(), cantidad, importes: { PEN } },
    indice_actividad: indice,
  });

  it("gana quien vendió más, aunque otro mueva más mensajes", () => {
    const r = armarRanking([persona("Mucho chat", 1, 50000, 100), persona("Vende", 3, 90000, 10)]);
    expect(r.map((p) => p.nombre)).toEqual(["Vende", "Mucho chat"]);
    expect(r[0].puesto).toBe(1);
  });

  it("con las mismas ventas, desempata el importe y luego la actividad", () => {
    const r = armarRanking([persona("A", 2, 100, 90), persona("B", 2, 200, 10), persona("C", 2, 100, 95)]);
    expect(r.map((p) => p.nombre)).toEqual(["B", "C", "A"]);
  });
});

describe("sumarVenta", () => {
  it("suma por moneda y lleva la cuenta de las que no tienen precio", () => {
    const v = ventasEnCero();
    sumarVenta(v, { importe: 100, moneda: "PEN" });
    sumarVenta(v, { importe: 50, moneda: "PEN" });
    sumarVenta(v, { importe: 10, moneda: "USD" });
    sumarVenta(v, { importe: null, moneda: "PEN" });
    expect(v).toMatchObject({ cantidad: 4, importes: { PEN: 150, USD: 10 }, sin_precio: 1 });
  });
});

describe("quién está activo", () => {
  it("en línea son menos de 4 minutos, igual que Control", () => {
    expect(estaEnLinea(new Date(AHORA.getTime() - 3 * 60_000).toISOString(), AHORA)).toBe(true);
    expect(estaEnLinea(new Date(AHORA.getTime() - 4 * 60_000).toISOString(), AHORA)).toBe(false);
    expect(estaEnLinea(null, AHORA)).toBe(false);
  });

  it("pone primero a los conectados y deja fuera a solo lectura", () => {
    const r = armarActivos(
      [
        { user_id: "a", full_name: "Ana", account_role: "agent" },
        { user_id: "b", full_name: "Beto", account_role: "agent" },
        { user_id: "v", full_name: "Vero", account_role: "viewer" },
      ],
      [
        { user_id: "a", last_seen_at: "2026-10-30T10:00:00.000Z" },
        { user_id: "b", last_seen_at: new Date(AHORA.getTime() - 60_000).toISOString() },
      ],
      [{ user_id: "b", minutos: 12 }],
      AHORA,
    );
    expect(r.map((p) => p.nombre)).toEqual(["Beto", "Ana"]);
    expect(r[0]).toMatchObject({ en_linea: true, minutos_hoy: 12 });
    expect(r[1]).toMatchObject({ en_linea: false, minutos_hoy: 0 });
  });
});
