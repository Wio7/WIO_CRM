import { describe, expect, it } from "vitest";
import { AREA_KEYS, destinoDeArea, puedeVerCuentas, tiendaDeCuenta } from "./destinos";

const golden = { name: "Golden Habitat", brand_name: null, disabled_modules: [] as string[] };
const otra = { name: "Broker Home", brand_name: null, disabled_modules: [] as string[] };
const ORIGEN = "https://crm.example.com";

describe("destinoDeArea", () => {
  it("gerencia: ERP en el panel y sin app", () => {
    const d = destinoDeArea("gerencia", otra, ORIGEN);
    expect(d).toMatchObject({ key: "gerencia", label: "Gerencia", erpHref: "/dashboard", app: null, estado: "activa" });
  });

  it("ventas en Golden: Golden App (ventas) con su link externo", () => {
    const d = destinoDeArea("ventas", golden, ORIGEN);
    expect(d.erpHref).toBe("/contacts");
    expect(d.app).toEqual({ nombre: "Golden App (ventas)", url: "https://golden.wiocompany.com" });
  });

  it("ventas en otra cuenta: sin app", () => {
    expect(destinoDeArea("ventas", otra, ORIGEN).app).toBeNull();
  });

  it("ventas usa embudos si contactos esta apagado", () => {
    const d = destinoDeArea("ventas", { ...otra, disabled_modules: ["/contacts"] }, ORIGEN);
    expect(d.erpHref).toBe("/pipelines");
    expect(d.estado).toBe("activa");
  });

  it("ventas queda apagada si contactos y embudos estan apagados", () => {
    const d = destinoDeArea("ventas", { ...otra, disabled_modules: ["/contacts", "/pipelines"] }, ORIGEN);
    expect(d.estado).toBe("apagada");
  });

  it("legal: ERP en cuotas; app Golden Legal solo en Golden", () => {
    expect(destinoDeArea("legal", golden, ORIGEN)).toMatchObject({
      erpHref: "/payment-plans",
      app: { nombre: "Golden Legal", url: "https://golden-legal.vercel.app" },
    });
    expect(destinoDeArea("legal", otra, ORIGEN).app).toBeNull();
  });

  it("cobranzas: app interna con el origen actual y nombre segun la cuenta", () => {
    expect(destinoDeArea("cobranzas", golden, ORIGEN)).toMatchObject({
      erpHref: "/collections",
      app: { nombre: "Golden Cobranzas", url: `${ORIGEN}/cobranzas` },
    });
    expect(destinoDeArea("cobranzas", otra, ORIGEN).app?.nombre).toBe("Cobranzas");
  });

  it("cobranzas apagada si /collections esta apagado (o su requerido /payment-plans)", () => {
    expect(destinoDeArea("cobranzas", { ...otra, disabled_modules: ["/collections"] }, ORIGEN).estado).toBe("apagada");
    expect(destinoDeArea("cobranzas", { ...otra, disabled_modules: ["/payment-plans"] }, ORIGEN).estado).toBe("apagada");
  });

  it("contabilidad: ERP en cuotas y app Caja con nombre por cuenta", () => {
    expect(destinoDeArea("contabilidad", golden, ORIGEN)).toMatchObject({
      erpHref: "/payment-plans",
      app: { nombre: "Golden Caja", url: `${ORIGEN}/caja` },
    });
    expect(destinoDeArea("contabilidad", otra, ORIGEN).app?.nombre).toBe("Caja chica");
  });

  it("marketing: ERP en difusiones, sin app todavia", () => {
    const d = destinoDeArea("marketing", otra, ORIGEN);
    expect(d.erpHref).toBe("/broadcasts");
    expect(d.app).toBeNull();
    expect(destinoDeArea("marketing", { ...otra, disabled_modules: ["/broadcasts"] }, ORIGEN).estado).toBe("apagada");
  });

  it("tecnica y sin area: ERP en el panel, sin app", () => {
    expect(destinoDeArea("tecnica", otra, ORIGEN)).toMatchObject({ erpHref: "/dashboard", app: null });
    expect(destinoDeArea("sin_area", otra, ORIGEN)).toMatchObject({ label: "Sin área", erpHref: "/dashboard", app: null });
  });

  it("detecta Golden tambien por brand_name", () => {
    const d = destinoDeArea("cobranzas", { name: "Cuenta", brand_name: "Golden X", disabled_modules: [] }, ORIGEN);
    expect(d.app?.nombre).toBe("Golden Cobranzas");
  });

  it("sin origen, la app interna queda como ruta", () => {
    expect(destinoDeArea("cobranzas", otra).app?.url).toBe("/cobranzas");
  });

  it("orden fijo de areas", () => {
    expect(AREA_KEYS).toEqual(["gerencia", "ventas", "promueve", "legal", "cobranzas", "contabilidad", "marketing", "tecnica", "sin_area"]);
  });
});

describe("tiendaDeCuenta", () => {
  it("rama Tienda si /store esta encendido; app solo para Vita Life", () => {
    const vita = { name: "Vita Life", brand_name: null, disabled_modules: [] as string[] };
    expect(tiendaDeCuenta(vita)).toMatchObject({
      key: "tienda", erpHref: "/store", estado: "activa",
      app: { nombre: "Tienda", url: "https://vita-life-amber.vercel.app" },
    });
    expect(tiendaDeCuenta(otra)?.app).toBeNull();
  });
  it("sin rama si /store esta apagado", () => {
    expect(tiendaDeCuenta({ ...otra, disabled_modules: ["/store"] })).toBeNull();
  });
});

describe("puedeVerCuentas", () => {
  it("dueno y gerencia si; el resto no", () => {
    expect(puedeVerCuentas({ role: "owner", area: null })).toBe(true);
    expect(puedeVerCuentas({ role: "agent", area: "gerencia" })).toBe(true);
    expect(puedeVerCuentas({ role: "admin", area: "gerencia" })).toBe(true);
    expect(puedeVerCuentas({ role: "admin", area: "ventas" })).toBe(false);
    expect(puedeVerCuentas({ role: "agent", area: null })).toBe(false);
    expect(puedeVerCuentas({ role: null, area: "gerencia" })).toBe(false);
  });
});

describe("destinoDeArea promueve", () => {
  it("Promueve (externos): sin ERP; app Golden App solo en Golden", () => {
    expect(destinoDeArea("promueve", golden, ORIGEN)).toMatchObject({
      key: "promueve",
      label: "Promueve (externos)",
      sinErp: true,
      estado: "activa",
      app: { nombre: "Golden App", url: "https://golden.wiocompany.com" },
    });
    expect(destinoDeArea("promueve", otra, ORIGEN).app).toBeNull();
  });

  it("las demas areas conservan su ERP (sinErp no esta puesto)", () => {
    expect(destinoDeArea("ventas", golden, ORIGEN).sinErp).toBeUndefined();
  });
});
