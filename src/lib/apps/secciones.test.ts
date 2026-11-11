import { describe, expect, it } from "vitest";

import { esGolden, seccionActiva, subtituloApp, type SeccionDef } from "./secciones";

const SECCIONES: readonly SeccionDef[] = [
  { href: "/cobranzas", etiqueta: "Morosos", largo: "Cuotas y morosos", exacta: true, tambien: ["/cobranzas/cliente/"] },
  { href: "/cobranzas/vouchers", etiqueta: "Vouchers", largo: "Vouchers por revisar" },
  { href: "/cobranzas/gestiones", etiqueta: "Gestiones", largo: "Gestiones" },
];

describe("seccionActiva", () => {
  it("la ruta exacta activa su sección", () => {
    expect(seccionActiva("/cobranzas", SECCIONES)?.etiqueta).toBe("Morosos");
  });
  it("la raíz de la app no se queda activa en las otras secciones", () => {
    expect(seccionActiva("/cobranzas/vouchers", SECCIONES)?.etiqueta).toBe("Vouchers");
  });
  it("la ficha de un cliente cuelga de Morosos", () => {
    expect(seccionActiva("/cobranzas/cliente/abc", SECCIONES)?.etiqueta).toBe("Morosos");
  });
  it("las subrutas de una sección la mantienen activa", () => {
    expect(seccionActiva("/cobranzas/gestiones/2026", SECCIONES)?.etiqueta).toBe("Gestiones");
  });
  it("no confunde prefijos parecidos", () => {
    expect(seccionActiva("/cobranzas/gestionesX", SECCIONES)).toBeNull();
  });
  it("una ruta de otra app no activa nada", () => {
    expect(seccionActiva("/caja", SECCIONES)).toBeNull();
  });
});

describe("esGolden y subtituloApp", () => {
  it("reconoce la cuenta Golden por cuenta o marca", () => {
    expect(esGolden("Golden Habitat", null)).toBe(true);
    expect(esGolden(null, "Golden Dream")).toBe(true);
    expect(esGolden("Otra inmobiliaria", "Otra")).toBe(false);
  });
  it("el subtítulo dorado solo sale en Golden", () => {
    expect(subtituloApp("Golden Habitat", null)).toBe("GOLDEN · DREAM HABITAT");
    expect(subtituloApp("Otra", null)).toBeNull();
  });
});
