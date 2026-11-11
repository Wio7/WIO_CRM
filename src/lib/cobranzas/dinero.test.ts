import { describe, expect, it } from "vitest";

import { dinero } from "./dinero";

describe("dinero", () => {
  it("da el mismo texto en cualquier lugar (sirve para pantallas que se pintan en el servidor)", () => {
    expect(dinero(18060, "PEN")).toBe(dinero(18060, "PEN"));
    expect(dinero(18060, "PEN")).toMatch(/S\/.*18.?060/);
  });
  it("los dólares llevan su símbolo", () => {
    expect(dinero(640, "USD")).toMatch(/(US\$|USD).*640/);
  });
  it("una moneda inválida no rompe", () => {
    expect(dinero(5, "???")).toContain("5");
  });
});
