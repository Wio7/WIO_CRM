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

describe("canEnterApp — Administración", () => {
  it("entran administración, contabilidad, dueño y super admin", () => {
    expect(canEnterApp("administracion", v({ area: "administracion" }))).toBe(true);
    expect(canEnterApp("administracion", v({ area: "contabilidad" }))).toBe(true);
    expect(canEnterApp("administracion", v({ isOwner: true }))).toBe(true);
    expect(canEnterApp("administracion", v({ isSuperAdmin: true }))).toBe(true);
  });
  it("cobranzas, gerencia, legal, ventas, marketing, técnica y sin área no entran", () => {
    for (const area of ["cobranzas", "gerencia", "legal", "ventas", "marketing", "tecnica", null]) {
      expect(canEnterApp("administracion", v({ area })), String(area)).toBe(false);
    }
  });
  it("Promueve no entra ni siendo dueño", () => {
    expect(canEnterApp("administracion", v({ area: "promueve", isOwner: true }))).toBe(false);
  });
  it("quien cae en Administración desde otra área va a la suya o al ERP", () => {
    expect(entradaApp("administracion", v({ area: "cobranzas" }))).toEqual({ ok: false, destino: { href: "/cobranzas", etiqueta: "Ir a mi app" } });
    expect(entradaApp("administracion", v({ area: "legal" }))).toEqual({ ok: false, destino: { href: "/dashboard", etiqueta: "Ir al ERP web" } });
    expect(entradaApp("administracion", v({ area: "contabilidad" }))).toEqual({ ok: true });
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
  it("caja: administracion entra igual que contabilidad; cobranzas no", () => {
    expect(canEnterApp("caja", v({ area: "administracion" }))).toBe(true);
    expect(canEnterApp("cobranzas", v({ area: "administracion" }))).toBe(false);
    for (const app of ["marketing", "gerencia", "tecnica"] as const) {
      expect(canEnterApp(app, v({ area: "administracion" }))).toBe(false);
    }
  });
  it("dueño y super admin entran a todas", () => {
    for (const app of Object.keys(APPS) as (keyof typeof APPS)[]) {
      expect(canEnterApp(app, v({ isOwner: true }))).toBe(true);
      expect(canEnterApp(app, v({ isSuperAdmin: true }))).toBe(true);
    }
  });
});

describe("Promueve (externo)", () => {
  it("no entra a ninguna app ni con permisos de dueño", () => {
    for (const app of Object.keys(APPS) as (keyof typeof APPS)[]) {
      expect(canEnterApp(app, v({ area: "promueve" }))).toBe(false);
      expect(canEnterApp(app, v({ area: "promueve", isOwner: true }))).toBe(false);
    }
  });
  it("no tiene app propia en este repo", () => {
    expect(appDeArea("promueve")).toBeNull();
  });
});

describe("appDeArea — la app propia", () => {
  it("cobranzas tiene app en este repo", () => {
    expect(appDeArea("cobranzas")?.ruta).toBe("/cobranzas");
  });
  it("contabilidad cae en Caja mientras no exista su app", () => {
    expect(appDeArea("contabilidad")?.ruta).toBe("/caja");
  });
  it("administracion tiene su app propia; contabilidad sigue en la Caja", () => {
    expect(appDeArea("administracion")?.ruta).toBe("/administracion");
    expect(appDeArea("administracion")?.key).toBe("administracion");
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
  it("administracion ve 'otra área' con botón a su app en Cobranzas", () => {
    expect(entradaApp("cobranzas", v({ area: "administracion" }))).toEqual({ ok: false, destino: { href: "/administracion", etiqueta: "Ir a mi app" } });
  });
  it("quien no tiene app aquí va al ERP web", () => {
    const r = entradaApp("cobranzas", v({ area: "legal" }));
    expect(r).toEqual({ ok: false, destino: { href: "/dashboard", etiqueta: "Ir al ERP web" } });
    const sinArea = entradaApp("cobranzas", v());
    expect(sinArea).toEqual({ ok: false, destino: { href: "/dashboard", etiqueta: "Ir al ERP web" } });
  });
});
