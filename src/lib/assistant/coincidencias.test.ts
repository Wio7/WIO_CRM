import { describe, it, expect } from "vitest";

import { elegirCitaACorregir, fechaLima, nombreCoincide, pedidoDeCambioDeCita, sumarSaldos } from "./coincidencias";

describe("fechaLima", () => {
  it("una hora sin zona es hora de Lima, no UTC", () => {
    expect(fechaLima("2026-11-21T10:30:00")).toBe(Date.parse("2026-11-21T10:30:00-05:00"));
    expect(fechaLima("2026-11-21 10:30")).toBe(Date.parse("2026-11-21T10:30:00-05:00"));
  });
  it("respeta la zona si viene", () => {
    expect(fechaLima("2026-11-21T10:30:00-05:00")).toBe(Date.parse("2026-11-21T10:30:00-05:00"));
    expect(fechaLima("2026-11-21T15:30:00Z")).toBe(Date.parse("2026-11-21T15:30:00Z"));
  });
  it("basura es NaN", () => {
    expect(Number.isNaN(fechaLima("mañana"))).toBe(true);
  });
});

describe("nombreCoincide", () => {
  it("'Ana' es Ana Torres, no Mariana", () => {
    expect(nombreCoincide("Ana Torres", "ana")).toBe(true);
    expect(nombreCoincide("Mariana López", "ana")).toBe(false);
  });
  it("ignora tildes y acepta nombre y apellido", () => {
    expect(nombreCoincide("José García", "jose garcia")).toBe(true);
    expect(nombreCoincide("José García Pérez", "garcia")).toBe(true);
  });
});

describe("sumarSaldos", () => {
  it("suma los planes de un cliente por moneda, sin mezclar soles y dolares", () => {
    expect(
      sumarSaldos([
        { currency: "PEN", pending_amount: 1000, overdue_amount: 100, overdue_count: 1, next_due_date: "2026-12-05" },
        { currency: "PEN", pending_amount: 500, overdue_amount: 0, overdue_count: 0, next_due_date: "2026-11-30" },
        { currency: "USD", pending_amount: 2000, overdue_amount: 50, overdue_count: 2, next_due_date: null },
      ]),
    ).toEqual({
      planes: 3,
      atrasadas: 3,
      por_moneda: [
        { moneda: "PEN", pendiente: 1500, atrasado: 100 },
        { moneda: "USD", pendiente: 2000, atrasado: 50 },
      ],
      proximo_vencimiento: "2026-11-30",
    });
  });
});

describe("cambiar una cita", () => {
  const ahora = Date.parse("2026-11-21T12:00:00-05:00");
  it("hora nueva en hora de Lima, o estado", () => {
    expect(pedidoDeCambioDeCita({ nuevo_inicio: "2026-11-23T17:00:00" }, ahora)).toEqual({
      inicio: Date.parse("2026-11-23T17:00:00-05:00"),
      estado: null,
    });
    expect(pedidoDeCambioDeCita({ estado: "cumplida" }, ahora)).toEqual({ inicio: null, estado: "cumplida" });
  });
  it("no acepta horas pasadas ni pedidos vacíos", () => {
    expect(pedidoDeCambioDeCita({ nuevo_inicio: "2026-11-20T10:00:00" }, ahora)).toEqual({ error: "Esa hora ya pasó." });
    expect("error" in pedidoDeCambioDeCita({}, ahora)).toBe(true);
    expect("error" in pedidoDeCambioDeCita({ estado: "borrada" }, ahora)).toBe(true);
  });
  it("elige la próxima pendiente, o la última si todas pasaron", () => {
    const citas = [
      { id: "a", starts_at: "2026-11-19T10:00:00-05:00" },
      { id: "b", starts_at: "2026-11-23T10:00:00-05:00" },
      { id: "c", starts_at: "2026-11-25T10:00:00-05:00" },
    ];
    expect(elegirCitaACorregir(citas, ahora)?.id).toBe("b");
    expect(elegirCitaACorregir(citas.slice(0, 1), ahora)?.id).toBe("a");
    expect(elegirCitaACorregir([], ahora)).toBeNull();
  });
});
