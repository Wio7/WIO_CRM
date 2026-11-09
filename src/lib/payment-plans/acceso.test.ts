import { describe, expect, it } from "vitest";
import { calendarioACuotas, chunk, esFaltaDeObjeto, sinAccesoCobranzas } from "./acceso";

describe("sinAccesoCobranzas", () => {
  it("solo es true cuando cobranzas es exactamente false", () => {
    expect(sinAccesoCobranzas({ cobranzas: false, cronograma: true })).toBe(true);
    expect(sinAccesoCobranzas({ cobranzas: true })).toBe(false);
  });
  it("null (084 sin aplicar) o clave ausente no oculta nada", () => {
    expect(sinAccesoCobranzas(null)).toBe(false);
    expect(sinAccesoCobranzas(undefined)).toBe(false);
    expect(sinAccesoCobranzas({})).toBe(false);
  });
});

describe("chunk", () => {
  it("parte en tandas del tamaño dado", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("lista vacía da cero tandas", () => {
    expect(chunk([], 200)).toEqual([]);
  });
  it("500 ids en tandas de 200 dan 3", () => {
    const ids = Array.from({ length: 500 }, (_, i) => i);
    expect(chunk(ids, 200).map((c) => c.length)).toEqual([200, 200, 100]);
  });
});

describe("calendarioACuotas", () => {
  it("pendiente queda pendiente y cerrada queda pagada, sin columnas de pago", () => {
    const r = calendarioACuotas([
      { id: "a", plan_id: "p", account_id: "x", number: 1, amount: 100, due_date: "2026-01-05", state: "cerrada" },
      { id: "b", plan_id: "p", account_id: "x", number: 2, amount: 100, due_date: "2026-02-05", state: "pendiente" },
    ]);
    expect(r.map((c) => c.status)).toEqual(["pagada", "pendiente"]);
    expect(r[0].paid_at).toBeUndefined();
    expect(r[1].voucher_path).toBeUndefined();
  });
});

describe("esFaltaDeObjeto", () => {
  it("tolera tabla/vista/función inexistente y nada más", () => {
    expect(esFaltaDeObjeto({ code: "42P01" })).toBe(true);
    expect(esFaltaDeObjeto({ code: "PGRST205" })).toBe(true);
    expect(esFaltaDeObjeto({ code: "PGRST202" })).toBe(true);
    expect(esFaltaDeObjeto({ code: "42501" })).toBe(false);
    expect(esFaltaDeObjeto(null)).toBe(false);
  });
});
