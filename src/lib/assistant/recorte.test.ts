import { describe, it, expect } from "vitest";

import { paraElModelo } from "./recorte";

describe("paraElModelo", () => {
  it("lo que cabe va tal cual", () => {
    expect(paraElModelo({ a: 1 }, 100)).toBe('{"a":1}');
  });

  it("una conversacion larga pierde lo mas viejo, no lo mas nuevo, y sigue siendo JSON", () => {
    const conversacion = Array.from({ length: 60 }, (_, i) => ({ texto: `mensaje ${i} `.padEnd(200, ".") }));
    const salida = paraElModelo({ cliente: "Ana", conversacion }, 4000);
    expect(salida.length).toBeLessThanOrEqual(4000);
    const d = JSON.parse(salida);
    expect(d.cliente).toBe("Ana");
    expect(d.recortado).toBe(true);
    expect(d.conversacion.at(-1).texto).toMatch(/^mensaje 59 /);
    expect(d.conversacion[0].texto).not.toMatch(/^mensaje 0 /);
  });

  it("otras listas pierden el final y se avisa", () => {
    const citas = Array.from({ length: 100 }, (_, i) => ({ cuando: `cita ${i}`.padEnd(100, ".") }));
    const d = JSON.parse(paraElModelo({ citas }, 3000));
    expect(d.citas[0].cuando).toMatch(/^cita 0/);
    expect(d.recortado).toBe(true);
  });

  it("si no hay listas, corta el texto pero devuelve JSON valido", () => {
    const d = JSON.parse(paraElModelo({ informacion: "x".repeat(5000) }, 1000));
    expect(d.recortado).toBe(true);
    expect(typeof d.contenido).toBe("string");
  });
});
