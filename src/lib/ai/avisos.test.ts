import { describe, expect, it } from "vitest";
import { avisoAsesor, avisoIa, hayQueAvisar } from "./avisos";

describe("avisos con la marca de la cuenta", () => {
  it("Broker Home no dice Golden", () => {
    expect(avisoAsesor("Julio", "Broker Home")).toBe("Hola, soy Julio de Broker Home 👋 Desde aquí te atiendo yo.");
    expect(avisoIa("Broker Home")).toContain("asistente virtual de Broker Home");
    expect(avisoAsesor("Julio", "Broker Home")).not.toMatch(/golden/i);
    expect(avisoIa("Broker Home")).not.toMatch(/golden/i);
  });
  it("Golden queda igual que antes", () => {
    expect(avisoAsesor("Sara", "Golden Habitat")).toBe("Hola, soy Sara de Golden Habitat 👋 Desde aquí te atiendo yo.");
    expect(avisoIa("Golden Habitat")).toBe(
      "Te dejo con la asistente virtual de Golden Habitat, que te responde al instante a cualquier hora. Si necesitas a una persona, dilo y te paso con un asesor. 🙌",
    );
  });
  it("sin nombre ni marca no inventa", () => {
    expect(avisoAsesor("", null)).toBe("Hola, soy un asesor 👋 Desde aquí te atiendo yo.");
    expect(avisoIa(null)).toMatch(/^Te dejo con la asistente virtual, que/);
  });
});

describe("hayQueAvisar", () => {
  it("avisa solo si cambia quién contesta", () => {
    expect(hayQueAvisar(false, false)).toBe(true); // tomar una conversación de la IA
    expect(hayQueAvisar(true, false)).toBe(false); // ya la tenía: segundo toque
    expect(hayQueAvisar(true, true)).toBe(true); // devolverla
    expect(hayQueAvisar(false, true)).toBe(false); // ya estaba con la IA
    expect(hayQueAvisar(null, false)).toBe(true);
  });
});
