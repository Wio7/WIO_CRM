import { describe, expect, it } from "vitest";
import { limiteEnTexto, semaforoDe } from "./calidad";

describe("calidad del número", () => {
  it("traduce la calificación de Meta a semáforo", () => {
    expect(semaforoDe("GREEN")).toBe("verde");
    expect(semaforoDe("yellow")).toBe("amarillo");
    expect(semaforoDe("RED")).toBe("rojo");
    expect(semaforoDe("UNKNOWN")).toBe("gris");
    expect(semaforoDe(null)).toBe("gris");
  });
  it("explica el límite diario", () => {
    expect(limiteEnTexto("TIER_250")).toBe("Hasta 250 personas nuevas al día");
    expect(limiteEnTexto("TIER_1K")).toMatch(/^Hasta 1.000 personas/);
    expect(limiteEnTexto("TIER_UNLIMITED")).toBe("Sin límite de personas nuevas al día");
    expect(limiteEnTexto(undefined)).toBeNull();
    expect(limiteEnTexto("raro")).toBeNull();
  });
});
