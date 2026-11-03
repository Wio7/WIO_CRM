import { describe, expect, it } from "vitest";

import type { ProyectoDeGolden } from "@/lib/golden/catalogo";
import { buscarProyecto, elegirMaterial } from "./material";

const MB = 1024 * 1024;
const BASE = "https://golden.test/";

function proyecto(id: string, nombre: string, media: ProyectoDeGolden["media"], nombreCorto: string | null = null) {
  return { id, nombre, nombreCorto, media } as ProyectoDeGolden;
}

const jade = proyecto(
  "casa-jade",
  "Casa Jade",
  {
    brochure: { ruta: "/assets/casa jade/brochure.pdf", bytes: 4 * MB },
    video: { ruta: "/assets/casa-jade/recorrido.mp4", bytes: 11 * MB },
    foto: { ruta: "/assets/casa-jade/cover.jpg", bytes: 200_000 },
  },
);

describe("elegirMaterial", () => {
  it("arma el enlace con la dirección de la app y codifica los espacios", () => {
    expect(elegirMaterial(jade, "brochure", BASE)).toEqual({
      tipo: "brochure",
      kind: "document",
      url: "https://golden.test/assets/casa%20jade/brochure.pdf",
      nombre: "Brochure Casa Jade.pdf",
      etiqueta: "Brochure de Casa Jade",
      comoEnlace: false,
    });
  });

  it("un video de hasta 16 MB se sube", () => {
    expect(elegirMaterial(jade, "video", BASE)).toMatchObject({ kind: "video", comoEnlace: false });
  });

  it("un video de más de 16 MB va como enlace", () => {
    const pesado = proyecto("r", "Rinconada", {
      brochure: null,
      video: { ruta: "/r.mp4", bytes: 42 * MB },
      foto: null,
    });
    expect(elegirMaterial(pesado, "video", BASE)).toMatchObject({ comoEnlace: true });
  });

  it("una foto de más de 5 MB va como enlace", () => {
    const pesada = proyecto("r", "Rinconada", {
      brochure: null,
      video: null,
      foto: { ruta: "/r.jpg", bytes: 6 * MB },
    });
    expect(elegirMaterial(pesada, "foto", BASE)).toMatchObject({ kind: "image", comoEnlace: true });
  });

  it("sin ese material devuelve null", () => {
    const lote = proyecto("colinas", "Colinas", { brochure: null, video: null, foto: null });
    expect(elegirMaterial(lote, "brochure", BASE)).toBeNull();
    expect(elegirMaterial(proyecto("v", "Viejo", undefined), "brochure", BASE)).toBeNull();
  });
});

describe("buscarProyecto", () => {
  const lista = [
    jade,
    proyecto("colinas-1", "Colinas de Ica I", undefined, "Colinas I"),
    proyecto("colinas-2", "Colinas de Ica II", undefined, "Colinas II"),
  ];

  it("encuentra por parte del nombre y sin tildes", () => {
    expect(buscarProyecto(lista, "JADE").uno?.id).toBe("casa-jade");
    expect(buscarProyecto(lista, "cása jade").uno?.id).toBe("casa-jade");
  });

  it("el nombre corto exacto gana sobre los parecidos", () => {
    expect(buscarProyecto(lista, "colinas ii").uno?.id).toBe("colinas-2");
  });

  it("con varios parecidos no elige", () => {
    expect(buscarProyecto(lista, "colinas").varios?.map((p) => p.id)).toEqual(["colinas-1", "colinas-2"]);
  });

  it("sin coincidencias devuelve la lista completa para preguntar", () => {
    expect(buscarProyecto(lista, "zzz").uno).toBeUndefined();
    expect(buscarProyecto(lista, "zzz").varios).toHaveLength(3);
  });
});
