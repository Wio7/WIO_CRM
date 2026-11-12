import { describe, expect, it } from "vitest";

import { appDeLogin, appLoginPath, isAppPublicPath, isProtectedPath, safeNextPath } from "./app-paths";

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
  it("las demostraciones con datos inventados se abren sin sesión", () => {
    for (const p of ["/cobranzas/demo", "/cobranzas/demo/vouchers", "/cobranzas/demo/cliente/d1", "/caja/demo"]) {
      expect(isAppPublicPath(p), p).toBe(true);
      expect(isProtectedPath(p), p).toBe(false);
    }
  });
  it("la demo no abre rutas parecidas ni la app real", () => {
    for (const p of ["/cobranzas/demoX", "/caja/demox", "/caja/demo/otra", "/caja", "/cobranzas"]) {
      expect(isAppPublicPath(p), p).toBe(false);
    }
  });
  it("lo demás de la app pide sesión", () => {
    expect(isAppPublicPath("/cobranzas")).toBe(false);
    expect(isAppPublicPath("/cobranzas/loginx")).toBe(false);
    expect(isAppPublicPath("/cobranzas/cliente/abc")).toBe(false);
  });
});

describe("app de Administración", () => {
  it("vuelve a su app tras el login y tiene login propio", () => {
    expect(safeNextPath("/administracion/estado-de-cuenta")).toBe("/administracion/estado-de-cuenta");
    expect(safeNextPath("/administracionevil")).toBe("/dashboard");
    expect(safeNextPath("/administracion/login", "/administracion")).toBe("/administracion");
    expect(appLoginPath("/administracion")).toBe("/administracion/login");
    expect(appLoginPath("/administracion/por-validar")).toBe("/administracion/login");
    expect(appLoginPath("/administracionevil")).toBe("/login");
  });
  it("su login, manifiesto, íconos y demo son públicos; lo demás pide sesión", () => {
    for (const p of ["/administracion/login", "/administracion/manifest.webmanifest", "/administracion/icono/192", "/administracion/demo", "/administracion/demo/estado-de-cuenta"]) {
      expect(isAppPublicPath(p), p).toBe(true);
      expect(isProtectedPath(p), p).toBe(false);
    }
    for (const p of ["/administracion", "/administracion/estado-de-cuenta", "/administracion/por-validar", "/administracion/loginx", "/administracion/demoX"]) {
      expect(isAppPublicPath(p), p).toBe(false);
      expect(isProtectedPath(p), p).toBe(true);
    }
  });
  it("appDeLogin dice a qué app pertenece una pantalla de login", () => {
    expect(appDeLogin("/administracion/login")).toBe("/administracion");
    expect(appDeLogin("/cobranzas/login")).toBe("/cobranzas");
    expect(appDeLogin("/login")).toBeNull();
    expect(appDeLogin("/administracion")).toBeNull();
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
