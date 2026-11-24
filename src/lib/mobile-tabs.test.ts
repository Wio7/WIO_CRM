import { describe, expect, it } from "vitest";
import { mobileTabs, visibleAreas } from "./mobile-tabs";

describe("barra inferior del celular", () => {
  it("muestra Inicio y tres secciones", () => {
    expect(mobileTabs([], null)).toEqual(["/dashboard", "/inbox", "/contacts", "/pipelines"]);
  });
  it("reemplaza un módulo apagado por el siguiente", () => {
    expect(mobileTabs(["/pipelines"], null)).toEqual(["/dashboard", "/inbox", "/contacts", "/calendar"]);
  });
  it("no lista módulos apagados en Más", () => {
    const hrefs = visibleAreas(["/flows"], null).flatMap((a) => a.hrefs);
    expect(hrefs).not.toContain("/flows");
    expect(hrefs).toContain("/agents");
  });
});
