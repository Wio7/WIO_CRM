import { describe, expect, it } from "vitest";

import { APPS, appDeArea, canEnterApp, entradaApp, type Viewer } from "./acceso";

const v = (over: Partial<Viewer> = {}): Viewer => ({ area: null, isOwner: false, isSuperAdmin: false, ...over });

describe("canEnterApp — Cobranzas", () => {
  it("entran cobranzas, gerencia, dueño y super admin", () => {
    expect(canEnterApp("cobranzas", v({ area: "cobranzas" }))).toBe(true);
    expect(canEnterApp("cobranzas", v({ area: "gerencia" }))).toBe(true);
    expect(canEnterApp("cobranzas", v({ isOwner: true }))).toBe(true);
    expect(canEnterApp("cobranzas", v({ isSuperAdmin: true }))).toBe(true);
  });
  it("contabilidad NO entra aunque pueda leer pagos", () => {
    expect(canEnterApp("cobranzas", v({ area: "contabilidad" }))).toBe(false);
  });
  it("legal, ventas, marketing, técnica y sin área no entran", () => {
    for (const area of ["legal", "ventas", "marketing", "tecnica", null]) {
      expect(canEnterApp("cobranzas", v({ area }))).toBe(false);
    }
  });
  it("un administrador sin área de cobranzas no entra solo por ser admin", () => {
    expect(canEnterApp("cobranzas", v())).toBe(false);
  });
});

describe("canEnterApp — otras apps (misma regla)", () => {
  it("marketing, gerencia y técnica van por su área", () => {
    expect(canEnterApp("marketing", v({ area: "marketing" }))).toBe(true);
    expect(canEnterApp("marketing", v({ area: "cobranzas" }))).toBe(false);
    expect(canEnterApp("gerencia", v({ area: "gerencia" }))).toBe(true);
    expect(canEnterApp("tecnica", v({ area: "tecnica" }))).toBe(true);
  });
  it("caja: contabilidad y gerencia", () => {
    expect(canEnterApp("caja", v({ area: "contabilidad" }))).toBe(true);
    expect(canEnterApp("caja", v({ area: "gerencia" }))).toBe(true);
    expect(canEnterApp("caja", v({ area: "cobranzas" }))).toBe(false);
  });
  it("dueño y super admin entran a todas", () => {
    for (const app of Object.keys(APPS) as (keyof typeof APPS)[]) {
      expect(canEnterApp(app, v({ isOwner: true }))).toBe(true);
      expect(canEnterApp(app, v({ isSuperAdmin: true }))).toBe(true);
    }
  });
});

describe("appDeArea — la app propia", () => {
  it("cobranzas tiene app en este repo", () => {
    expect(appDeArea("cobranzas")?.ruta).toBe("/cobranzas");
  });
  it("contabilidad cae en Caja mientras no exista su app", () => {
    expect(appDeArea("contabilidad")?.ruta).toBe("/caja");
  });
  it("legal y ventas viven en otro repo: sin ruta aquí", () => {
    expect(appDeArea("legal")).toBeNull();
    expect(appDeArea("ventas")).toBeNull();
    expect(appDeArea(null)).toBeNull();
  });
});

describe("entradaApp", () => {
  it("permite pasar a quien es del área", () => {
    expect(entradaApp("cobranzas", v({ area: "cobranzas" }))).toEqual({ ok: true });
  });
  it("contabilidad ve 'otra área' con botón a Caja", () => {
    const r = entradaApp("cobranzas", v({ area: "contabilidad" }));
    expect(r).toEqual({ ok: false, destino: { href: "/caja", etiqueta: "Ir a mi app" } });
  });
  it("quien no tiene app aquí va al ERP web", () => {
    const r = entradaApp("cobranzas", v({ area: "legal" }));
    expect(r).toEqual({ ok: false, destino: { href: "/dashboard", etiqueta: "Ir al ERP web" } });
    const sinArea = entradaApp("cobranzas", v());
    expect(sinArea).toEqual({ ok: false, destino: { href: "/dashboard", etiqueta: "Ir al ERP web" } });
  });
});
