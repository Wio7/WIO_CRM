import { describe, expect, it } from "vitest";

import { cajaMenuLabel } from "./menu";

describe("nombre del menú de caja", () => {
  it("Golden ve Golden Caja", () => {
    expect(cajaMenuLabel("Golden Habitat · Inmobiliaria")).toBe("Golden Caja");
    expect(cajaMenuLabel("Cuenta", "GOLDEN HABITAT")).toBe("Golden Caja");
  });
  it("las demás cuentas ven Caja chica, nunca Wio Suite", () => {
    for (const nombre of ["Broker Home", "", null, undefined]) {
      const label = cajaMenuLabel(nombre as string);
      expect(label).toBe("Caja chica");
      expect(label).not.toMatch(/wio/i);
    }
  });
});
