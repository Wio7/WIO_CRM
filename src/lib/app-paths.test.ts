import { describe, expect, it } from "vitest";

import { safeNextPath } from "./app-paths";

describe("safeNextPath", () => {
  it("acepta rutas de app permitidas", () => {
    expect(safeNextPath("/caja")).toBe("/caja");
    expect(safeNextPath("/caja/demo")).toBe("/caja/demo");
  });
  it("vuelve a cobranzas", () => {
    expect(safeNextPath("/collections/bandeja")).toBe("/collections/bandeja");
    expect(safeNextPath("/collectionsevil")).toBe("/dashboard");
  });
  it("rechaza prefijos parecidos y destinos externos", () => {
    expect(safeNextPath("/cajaevil")).toBe("/dashboard");
    expect(safeNextPath("https://evil.com")).toBe("/dashboard");
    expect(safeNextPath("//evil.com")).toBe("/dashboard");
    expect(safeNextPath(null)).toBe("/dashboard");
  });
});
