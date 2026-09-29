import { describe, expect, it } from "vitest";

import { limpiarInventos } from "./whisper";

describe("limpiarInventos", () => {
  it("deja pasar lo que sí se dijo", () => {
    expect(limpiarInventos("  ¿Qué tengo hoy?  ")).toBe("¿Qué tengo hoy?");
  });

  it("descarta los subtítulos que Whisper se inventa con el silencio", () => {
    expect(limpiarInventos("Subtítulos realizados por la comunidad de Amara.org")).toBe("");
    expect(limpiarInventos("Gracias por ver el video")).toBe("");
  });
});
