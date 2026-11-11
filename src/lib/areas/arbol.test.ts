import { describe, expect, it } from "vitest";
import { armarArbol, type MiembroArbol } from "./arbol";

const cuenta = { name: "Golden Habitat", brand_name: null, disabled_modules: ["/broadcasts"] as string[] };
const m = (id: string, area: string | null, extra: Partial<MiembroArbol> = {}): MiembroArbol => ({
  id, full_name: id, email: `${id}@x.com`, account_role: "agent", area, ...extra,
});

describe("armarArbol", () => {
  it("ordena las ramas por area, con sus personas, y deja Sin area al final", () => {
    const ramas = armarArbol([m("a", "cobranzas"), m("b", null), m("c", "gerencia"), m("d", "cobranzas")], cuenta, "https://o");
    const keys = ramas.map((r) => r.key);
    expect(keys.slice(0, 4)).toEqual(["gerencia", "ventas", "legal", "cobranzas"]);
    expect(keys[keys.length - 1]).toBe("sin_area");
    expect(ramas.find((r) => r.key === "cobranzas")!.personas.map((p) => p.id)).toEqual(["a", "d"]);
    expect(ramas.find((r) => r.key === "sin_area")!.personas.map((p) => p.id)).toEqual(["b"]);
  });

  it("un area desconocida cae en Sin area", () => {
    const ramas = armarArbol([m("a", "astronauta")], cuenta);
    expect(ramas.find((r) => r.key === "sin_area")!.personas).toHaveLength(1);
  });

  it("marca el estado del area segun los modulos apagados", () => {
    const ramas = armarArbol([], cuenta);
    expect(ramas.find((r) => r.key === "marketing")!.estado).toBe("apagada");
    expect(ramas.find((r) => r.key === "cobranzas")!.estado).toBe("activa");
  });

  it("oculta Sin area cuando nadie esta ahi, y no agrega Tienda si esta apagada", () => {
    const ramas = armarArbol([m("a", "legal")], { ...cuenta, disabled_modules: ["/store"] });
    expect(ramas.some((r) => r.key === "sin_area")).toBe(false);
    expect(ramas.some((r) => r.key === "tienda")).toBe(false);
  });

  it("agrega Tienda antes de Sin area cuando /store esta encendido", () => {
    const ramas = armarArbol([m("a", null)], { name: "Vita Life", brand_name: null, disabled_modules: [] });
    const keys = ramas.map((r) => r.key);
    expect(keys.indexOf("tienda")).toBe(keys.indexOf("sin_area") - 1);
    expect(ramas.find((r) => r.key === "tienda")!.personas).toEqual([]);
  });

  it("cada persona trae estado Activo (profiles no tiene columna de estado)", () => {
    const ramas = armarArbol([m("a", "legal")], cuenta);
    expect(ramas.find((r) => r.key === "legal")!.personas[0].estado).toBe("Activo");
  });
});
