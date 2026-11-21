import { describe, expect, it } from "vitest";
import { nombreDePlantilla, pedidoDePlantilla } from "./plantilla-simple";

describe("plantilla simple de la app", () => {
  it("normaliza el nombre como lo pide Meta", () => {
    expect(nombreDePlantilla("Retomar conversación 1")).toBe("retomar_conversacion_1");
    expect(nombreDePlantilla("  ¡Promo Lotes!  ")).toBe("promo_lotes");
  });

  it("arma el payload con un ejemplo por cada {{n}}", () => {
    const r = pedidoDePlantilla({
      nombre: "Retomar",
      categoria: "marketing",
      texto: "Hola {{1}}, ¿sigues buscando lote en Juliaca? Te cuento las novedades 😊",
    });
    expect("payload" in r && r.payload).toMatchObject({
      name: "retomar",
      category: "Marketing",
      language: "es",
      sample_values: { body: ["Karina"] },
    });
  });

  it("sin variables no manda ejemplos", () => {
    const r = pedidoDePlantilla({ nombre: "aviso", categoria: "UTILITY", texto: "Tu visita está confirmada." });
    expect("payload" in r && r.payload.sample_values).toBeUndefined();
  });

  it("rechaza lo que falta o está mal", () => {
    expect(pedidoDePlantilla({ nombre: "", categoria: "MARKETING", texto: "x" })).toEqual({ error: "Ponle un nombre a la plantilla." });
    expect(pedidoDePlantilla({ nombre: "a", categoria: "AUTHENTICATION", texto: "x" })).toEqual({
      error: "El tipo tiene que ser Marketing o Utilidad.",
    });
    expect(pedidoDePlantilla({ nombre: "a", categoria: "UTILITY", texto: "  " })).toEqual({ error: "Escribe el texto de la plantilla." });
  });
});
