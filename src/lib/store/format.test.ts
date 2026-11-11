import { describe, expect, it } from "vitest";

import { buildProductRow, customerWhatsappUrl, formatMoney, parsePrice } from "./format";

describe("parsePrice", () => {
  it.each([
    ["269", 269],
    ["529.50", 529.5],
    ["529,50", 529.5],
    [" 759 ", 759],
    ["0", 0],
  ])("lee %s", (raw, expected) => {
    expect(parsePrice(raw)).toBe(expected);
  });
  it.each(["", "abc", "-5", "1.234,5", "12.345"])("rechaza %s", (raw) => {
    expect(parsePrice(raw)).toBeNull();
  });
});

describe("buildProductRow", () => {
  const form = {
    name: " Power Maker ",
    subtitle: "1 caja",
    description: "",
    price: "269",
    includes: "1 caja\n\n 1 Kolina ",
    badge: " ",
    sort: "2",
    image_url: "",
    active: true,
  };
  it("normaliza el formulario a una fila", () => {
    expect(buildProductRow(form)).toEqual({
      ok: true,
      row: {
        name: "Power Maker", subtitle: "1 caja", description: null, price: 269,
        includes: ["1 caja", "1 Kolina"], badge: null, sort: 2, image_url: null, active: true,
      },
    });
  });
  it("exige nombre y precio valido", () => {
    expect(buildProductRow({ ...form, name: " " })).toEqual({ ok: false, message: "Escribe el nombre del producto." });
    expect(buildProductRow({ ...form, price: "gratis" })).toEqual({ ok: false, message: "El precio no es valido." });
  });
  it("el orden vacio o invalido pasa a 0", () => {
    expect(buildProductRow({ ...form, sort: "x" })).toMatchObject({ ok: true, row: { sort: 0 } });
  });
});

describe("formatMoney", () => {
  it("muestra decimales solo cuando hacen falta", () => {
    expect(formatMoney(269, "PEN")).toMatch(/269(?!\.)/);
    expect(formatMoney(529.5, "PEN")).toMatch(/529\.50/);
  });
});

describe("customerWhatsappUrl", () => {
  it("agrega 51 a un celular peruano de 9 digitos", () => {
    expect(customerWhatsappUrl("999 111 222")).toBe("https://wa.me/51999111222");
  });
  it("respeta un numero con codigo de pais", () => {
    expect(customerWhatsappUrl("+34 612 345 678")).toBe("https://wa.me/34612345678");
  });
  it("devuelve null si no parece un celular", () => {
    expect(customerWhatsappUrl("12345")).toBeNull();
  });
});
