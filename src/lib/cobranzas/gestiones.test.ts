import { describe, expect, it } from "vitest";

import type { CollectionAction } from "@/lib/collection-actions";
import { ordenarGestiones, resumenGestiones } from "./gestiones";

const g = (o: Partial<CollectionAction> & { id: string; contact_id: string; created_at: string }): CollectionAction => ({
  plan_id: null, channel: "llamada", result: "contactado", promise_date: null, promise_amount: null,
  note: null, created_by: null, ...o,
});

const HOY = "2026-11-10";

describe("resumenGestiones", () => {
  const acciones = [
    g({ id: "1", contact_id: "a", created_at: "2026-11-01T10:00:00Z", result: "promesa", promise_date: "2026-11-05" }),
    g({ id: "2", contact_id: "b", created_at: "2026-11-02T10:00:00Z", result: "promesa", promise_date: "2026-11-20" }),
    // c prometió pero después tuvo otra gestión: manda la última
    g({ id: "3", contact_id: "c", created_at: "2026-11-01T10:00:00Z", result: "promesa", promise_date: "2026-11-02" }),
    g({ id: "4", contact_id: "c", created_at: "2026-11-03T10:00:00Z", result: "no_contesta" }),
  ];
  it("cuenta promesas vencidas y por cumplir según la última gestión de cada cliente", () => {
    expect(resumenGestiones(acciones, HOY)).toEqual({ vencidas: 1, vigentes: 1, clientes: 3, total: 4 });
  });
  it("sin gestiones, todo en cero", () => {
    expect(resumenGestiones([], HOY)).toEqual({ vencidas: 0, vigentes: 0, clientes: 0, total: 0 });
  });
});

describe("ordenarGestiones", () => {
  const acciones = [
    g({ id: "1", contact_id: "a", created_at: "2026-11-01T10:00:00Z", result: "promesa", promise_date: "2026-11-05" }),
    g({ id: "2", contact_id: "b", created_at: "2026-11-02T10:00:00Z", result: "promesa", promise_date: "2026-11-20" }),
    g({ id: "3", contact_id: "c", created_at: "2026-11-04T10:00:00Z", result: "no_contesta" }),
  ];
  it("'recientes' va de la más nueva a la más vieja, sin tocar la lista original", () => {
    const copia = [...acciones];
    expect(ordenarGestiones(acciones, "recientes", HOY).map((a) => a.id)).toEqual(["3", "2", "1"]);
    expect(acciones).toEqual(copia);
  });
  it("'vencidas' deja solo la última gestión de cada cliente si es promesa vencida", () => {
    expect(ordenarGestiones(acciones, "vencidas", HOY).map((a) => a.id)).toEqual(["1"]);
  });
  it("'vigentes' deja las promesas por cumplir, la más próxima primero", () => {
    expect(ordenarGestiones(acciones, "vigentes", HOY).map((a) => a.id)).toEqual(["2"]);
  });
});
