import { describe, expect, it } from "vitest";

import { hashCodigo, normalizarCelular, normalizarCodigo, validarRegistro } from "./registro";

const bueno = {
  nombre: "  María  Pérez ",
  celular: "987 654 321",
  correo: "  Maria.Perez@Gmail.com ",
  password: "una-clave-larga",
  codigo: "ab12-cd34-ef56",
};

describe("validarRegistro", () => {
  it("acepta datos buenos y los normaliza", () => {
    const r = validarRegistro(bueno);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.datos.nombre).toBe("María Pérez");
      expect(r.datos.celular).toBe("+51987654321");
      expect(r.datos.correo).toBe("maria.perez@gmail.com");
      expect(r.datos.codigoHash).toBe(hashCodigo("AB12CD34EF56"));
    }
  });

  it.each([
    ["nombre", { nombre: "" }],
    ["nombre", { nombre: "A" }],
    ["nombre", { nombre: "<script>alert(1)</script>" }],
    ["nombre", { nombre: "x".repeat(81) }],
    ["nombre", { nombre: 123 }],
    ["celular", { celular: "12345" }],
    ["celular", { celular: "887654321" }],
    ["celular", { celular: "98765432100" }],
    ["correo", { correo: "no-es-correo" }],
    ["correo", { correo: "a@b" }],
    ["correo", { correo: "a b@c.com" }],
    ["password", { password: "corta" }],
    ["password", { password: "x".repeat(73) }],
    ["password", { password: null }],
    ["codigo", { codigo: "" }],
    ["codigo", { codigo: "abc" }],
    ["codigo", { codigo: "¡¡¡¡¡¡¡¡¡¡" }],
    ["codigo", { codigo: "A".repeat(40) }],
  ])("rechaza %s mal escrito", (campo, cambio) => {
    const r = validarRegistro({ ...bueno, ...cambio });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.campo).toBe(campo);
  });

  it("rechaza un cuerpo que no es objeto", () => {
    expect(validarRegistro(null).ok).toBe(false);
    expect(validarRegistro("hola").ok).toBe(false);
  });
});

describe("código y celular", () => {
  it("normaliza igual que la base (mayúsculas, sin espacios ni guiones)", () => {
    expect(normalizarCodigo(" ab-12 cd ")).toBe("AB12CD");
  });
  it("el hash es SHA-256 hex y no depende del formato", () => {
    expect(hashCodigo("golden-2026x")).toBe(hashCodigo("GOLDEN 2026X"));
    expect(hashCodigo("golden-2026x")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("acepta +51 y separadores", () => {
    expect(normalizarCelular("+51 987-654-321")).toBe("+51987654321");
    expect(normalizarCelular("51987654321")).toBe("+51987654321");
    expect(normalizarCelular("(987) 654321")).toBe("+51987654321");
  });
});
