import { describe, expect, it } from "vitest";

import { nombreApp } from "./nombres";

describe("nombre de cada app por cuenta", () => {
  it("Golden ve 'Golden Cobranzas'", () => {
    expect(nombreApp("cobranzas", "Golden Habitat · Inmobiliaria")).toBe("Golden Cobranzas");
    expect(nombreApp("cobranzas", "Cuenta", "GOLDEN HABITAT")).toBe("Golden Cobranzas");
  });
  it("las demás ven 'Cobranzas' y nunca Wio Suite", () => {
    for (const nombre of ["Broker Home", "", null, undefined]) {
      const label = nombreApp("cobranzas", nombre as string);
      expect(label).toBe("Cobranzas");
      expect(label).not.toMatch(/wio/i);
    }
  });
  it("sirve para las próximas apps", () => {
    expect(nombreApp("marketing", "Golden Habitat")).toBe("Golden Marketing");
    expect(nombreApp("tecnica", "Otra")).toBe("Área técnica");
  });
});
