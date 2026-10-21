import { describe, expect, it } from "vitest";
import { loadAccountBrand, resolveAccountBrand } from "./account-brand";

const broker = { brand_name: "Broker Home", logo_url: "/brands/broker-home.png" };
const wio = { name: "Wio CRM", logo: "/logo.png", custom: false };

describe("marca por cuenta", () => {
  it.each([undefined, null, {}, { brand_name: "Broker Home" }, { logo_url: "  " }])(
    "conserva Wio cuando no hay logo: %j", (account) => {
      expect(resolveAccountBrand(account)).toEqual(wio);
    },
  );
  it("muestra la marca configurada y limpia espacios", () => {
    expect(resolveAccountBrand({ brand_name: " Broker Home ", logo_url: ` ${broker.logo_url} ` }))
      .toEqual({ name: "Broker Home", logo: broker.logo_url, custom: true });
  });
  it("conserva un nombre accesible si solo hay logo", () => {
    expect(resolveAccountBrand({ logo_url: broker.logo_url }).name).toBe("Wio CRM");
  });
  it("no retiene la marca de otra cuenta", () => {
    expect(resolveAccountBrand(broker).custom).toBe(true);
    expect(resolveAccountBrand({ brand_name: null, logo_url: null })).toEqual(wio);
  });
  it("carga una marca disponible", async () => {
    expect(await loadAccountBrand(async () => ({ data: broker, error: null }))).toEqual(broker);
  });
  it.each(["42703", "PGRST204", "42501"])("tolera errores de esquema/permisos: %s", async (code) => {
    const brand = await loadAccountBrand(async () => ({ data: null, error: { code } }));
    expect(brand).toEqual({ brand_name: null, logo_url: null });
    expect(resolveAccountBrand(brand)).toEqual(wio);
  });
  it("tolera una excepción de red", async () => {
    expect(resolveAccountBrand(await loadAccountBrand(async () => { throw new Error("red"); })))
      .toEqual(wio);
  });
  it("tolera una cuenta sin resultados", async () => {
    expect(resolveAccountBrand(await loadAccountBrand(async () => ({ data: null, error: null }))))
      .toEqual(wio);
  });
});
