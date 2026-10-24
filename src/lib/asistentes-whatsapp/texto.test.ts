import { describe, expect, it } from "vitest";

import { buscarCaja } from "./caja";
import { esSoloSaludo, leerComando, lineaDeMovimiento, resumenDelDia, soles, type CajaDelDia } from "./texto";

const caja = (over: Partial<CajaDelDia> = {}): CajaDelDia => ({
  name: "Restaurante",
  icon: "🍽️",
  balanceCents: 50000,
  inCents: 0,
  outCents: 0,
  transferInCents: 0,
  transferOutCents: 0,
  count: 0,
  largeExpenses: [],
  closure: null,
  pendingReplenishments: [],
  ...over,
});

describe("soles", () => {
  it("omite los céntimos cuando son cero y marca lo negativo", () => {
    expect(soles(12000)).toBe("S/ 120");
    expect(soles(3550)).toBe("S/ 35.50");
    expect(soles(-500)).toBe("−S/ 5");
  });
});

describe("resumenDelDia", () => {
  it("dice qué entró y salió por caja y el total", () => {
    const texto = resumenDelDia({
      day: "2026-10-22",
      isOwner: true,
      accountName: "Golden Habitat",
      boxes: [
        caja({ count: 2, inCents: 30000, outCents: 12000 }),
        caja({ name: "Cafetería", icon: null, balanceCents: 1000 }),
      ],
    });
    expect(texto).toContain("🍽️ *Restaurante*: entró S/ 300 · salió S/ 120. Saldo S/ 500.");
    expect(texto).toContain("*Cafetería*: sin movimientos. Saldo S/ 10.");
    expect(texto).toContain("Todavía no cierra la caja.");
    expect(texto).toContain("*Total*: entró S/ 300 · salió S/ 120. Saldo de todas: S/ 510.");
  });

  it("avisa gastos grandes, cierres con diferencia y reposiciones", () => {
    const texto = resumenDelDia({
      day: "2026-10-22",
      isOwner: true,
      accountName: null,
      boxes: [
        caja({
          count: 1,
          largeExpenses: [{ amountCents: 80000, concept: "Horno", actorName: "Lucero", justification: "Se malogró" }],
          closure: { diffCents: -2000, reason: "Vuelto mal dado", actorName: "Lucero" },
          pendingReplenishments: [{ amountCents: 20000, reason: "Compras", requesterName: "Lucero" }],
        }),
      ],
    });
    expect(texto).toContain("⚠️ Gasto grande: S/ 800 en Horno (Lucero): Se malogró");
    expect(texto).toContain("❗ Cerró con faltante de S/ 20: Vuelto mal dado");
    expect(texto).toContain("🙋 Lucero pide reposición de S/ 200: Compras");
    expect(texto).not.toContain("Total");
  });
});

describe("comandos y saludos", () => {
  it("reconoce los comandos con o sin tilde", () => {
    expect(leerComando("/Menú")).toBe("menu");
    expect(leerComando(" /caja ")).toBe("caja");
    expect(leerComando("/nada")).toBeNull();
    expect(leerComando("caja")).toBeNull();
  });

  it("un saludo suelto no es una pregunta", () => {
    expect(esSoloSaludo("Hola!")).toBe(true);
    expect(esSoloSaludo("buenos días")).toBe(true);
    expect(esSoloSaludo("hola, cómo va la cafetería")).toBe(false);
  });
});

describe("buscarCaja", () => {
  const cajas = [{ name: "Golden Habitat" }, { name: "La Jato · Hacienda" }, { name: "Cafetería" }, { name: "Restaurante" }];

  it("encuentra la caja aunque la digan a medias o sin tilde", () => {
    expect(buscarCaja(cajas, "cafeteria").una?.name).toBe("Cafetería");
    expect(buscarCaja(cajas, "el restaurante").una?.name).toBe("Restaurante");
    expect(buscarCaja(cajas, "la jato").una?.name).toBe("La Jato · Hacienda");
  });

  it("si no está segura, devuelve las opciones", () => {
    expect(buscarCaja(cajas, "panadería").varias).toHaveLength(4);
  });
});

describe("lineaDeMovimiento", () => {
  it("se lee como la confirmación del diseño", () => {
    expect(
      lineaDeMovimiento({
        caja: "Restaurante",
        kind: "expense",
        amountCents: 12000,
        concept: "Gas",
        paymentMethod: "yape",
        category: null,
        justification: null,
      }),
    ).toBe("−S/ 120 en Restaurante · Gas · Yape");
  });
});
