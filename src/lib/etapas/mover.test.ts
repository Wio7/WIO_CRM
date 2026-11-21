import { describe, expect, it } from "vitest";
import { claveDeEtapa } from "./mover";
import { parseGeneration } from "@/lib/ai/generate";

describe("claveDeEtapa", () => {
  it("entiende cómo lo dice el asesor", () => {
    expect(claveDeEtapa("Agendó visita")).toBe("agendo");
    expect(claveDeEtapa("separó")).toBe("compro");
    expect(claveDeEtapa("Compró")).toBe("compro");
    expect(claveDeEtapa("no le interesa")).toBe("perdido");
    expect(claveDeEtapa("en seguimiento")).toBe("seguimiento");
    expect(claveDeEtapa("contestó")).toBe("contesto");
    expect(claveDeEtapa("visitó el terreno")).toBe("visito");
  });
  it("no adivina", () => {
    expect(claveDeEtapa("")).toBeNull();
    expect(claveDeEtapa("banana")).toBeNull();
  });
});

describe("sello de etapa en la respuesta de la IA", () => {
  it("se lee y no le llega al cliente", () => {
    const r = parseGeneration("Perfecto, Karina 😊 ¿Qué día te queda bien? [[ETAPA:seguimiento]]");
    expect(r.etapa).toBe("seguimiento");
    expect(r.text).toBe("Perfecto, Karina 😊 ¿Qué día te queda bien?");
  });
  it("solo seguimiento o perdido; el resto se borra sin efecto", () => {
    const r = parseGeneration("Listo [[ETAPA:compro]]");
    expect(r.etapa ?? null).toBeNull();
    expect(r.text).toBe("Listo");
  });
  it("sin sello no hay etapa", () => {
    expect(parseGeneration("Hola").etapa ?? null).toBeNull();
  });
});
