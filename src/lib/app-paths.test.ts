import { describe, expect, it } from "vitest";

import { appLoginPath, isAppPublicPath, isProtectedPath, safeNextPath } from "./app-paths";

describe("safeNextPath", () => {
  it("acepta rutas de app permitidas", () => {
    expect(safeNextPath("/caja")).toBe("/caja");
    expect(safeNextPath("/caja/demo")).toBe("/caja/demo");
  });
  it("vuelve a cobranzas", () => {
    expect(safeNextPath("/collections/bandeja")).toBe("/collections/bandeja");
    expect(safeNextPath("/collectionsevil")).toBe("/dashboard");
  });
  it("vuelve a la app de Cobranzas", () => {
    expect(safeNextPath("/cobranzas")).toBe("/cobranzas");
    expect(safeNextPath("/cobranzas/vouchers")).toBe("/cobranzas/vouchers");
    expect(safeNextPath("/cobranzasevil")).toBe("/dashboard");
  });
  it("rechaza prefijos parecidos y destinos externos", () => {
    expect(safeNextPath("/cajaevil")).toBe("/dashboard");
    expect(safeNextPath("https://evil.com")).toBe("/dashboard");
    expect(safeNextPath("//evil.com")).toBe("/dashboard");
    expect(safeNextPath(null)).toBe("/dashboard");
  });
  it("sin destino válido usa el de reserva que se le da", () => {
    expect(safeNextPath(null, "/cobranzas")).toBe("/cobranzas");
    expect(safeNextPath("https://evil.com", "/cobranzas")).toBe("/cobranzas");
  });
  it("nunca devuelve al login de la app (evita el bucle)", () => {
    expect(safeNextPath("/cobranzas/login", "/cobranzas")).toBe("/cobranzas");
    expect(safeNextPath("/cobranzas/login?next=/x", "/cobranzas")).toBe("/cobranzas");
  });
});

describe("appLoginPath", () => {
  it("la app de Cobranzas tiene su propio login", () => {
    expect(appLoginPath("/cobranzas")).toBe("/cobranzas/login");
    expect(appLoginPath("/cobranzas/vouchers")).toBe("/cobranzas/login");
  });
  it("el resto usa /login (Caja no cambia)", () => {
    expect(appLoginPath("/caja")).toBe("/login");
    expect(appLoginPath("/dashboard")).toBe("/login");
    expect(appLoginPath("/cobranzasevil")).toBe("/login");
  });
});

describe("isAppPublicPath", () => {
  it("el login y el manifiesto de la app se abren sin sesión", () => {
    expect(isAppPublicPath("/cobranzas/login")).toBe(true);
    expect(isAppPublicPath("/cobranzas/manifest.webmanifest")).toBe(true);
    expect(isAppPublicPath("/cobranzas/icono/192")).toBe(true);
  });
  it("lo demás de la app pide sesión", () => {
    expect(isAppPublicPath("/cobranzas")).toBe(false);
    expect(isAppPublicPath("/cobranzas/loginx")).toBe(false);
    expect(isAppPublicPath("/cobranzas/cliente/abc")).toBe(false);
  });
});

describe("isProtectedPath", () => {
  it("incluye las rutas de las apps", () => {
    for (const p of ["/dashboard", "/caja", "/collections", "/cobranzas", "/cobranzas/gestiones", "/cuentas"]) {
      expect(isProtectedPath(p)).toBe(true);
    }
  });
  it("no incluye el login ni lo público", () => {
    expect(isProtectedPath("/login")).toBe(false);
    expect(isProtectedPath("/cobranzas/login")).toBe(false);
  });
});
