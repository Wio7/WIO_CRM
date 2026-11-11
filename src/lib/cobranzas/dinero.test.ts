import { describe, expect, it } from "vitest";

import { dinero } from "./dinero";

describe("dinero", () => {
  it("soles como en la Caja: S/ con coma de miles y dos decimales", () => {
    expect(dinero(18060, "PEN")).toBe("S/ 18,060.00");
    expect(dinero(1490.5, "PEN")).toBe("S/ 1,490.50");
  });
  it("los dólares llevan US$", () => {
    expect(dinero(640, "USD")).toBe("US$ 640.00");
  });
  it("sin moneda es soles y una moneda desconocida muestra su código", () => {
    expect(dinero(5, "")).toBe("S/ 5.00");
    expect(dinero(5, "clp")).toBe("CLP 5.00");
  });
  it("negativos y valores raros no rompen", () => {
    expect(dinero(-12.3, "PEN")).toBe("-S/ 12.30");
    expect(dinero(Number.NaN, "PEN")).toBe("S/ 0.00");
  });
});
