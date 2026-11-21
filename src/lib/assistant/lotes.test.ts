import { describe, it, expect } from "vitest";

import type { CatalogoDeGolden, ProyectoDeGolden } from "@/lib/golden/catalogo";
import { leerCodigoLote, buscarLotes, cuotaLote, cuotaFrancesa, simularCuotas } from "./lotes";

function proyecto(over: Partial<ProyectoDeGolden> = {}): ProyectoDeGolden {
  return {
    id: "colinas-1",
    nombre: "Las Colinas del Este — Etapa I",
    nombreCorto: "Colinas I",
    lema: null,
    categoria: "lotes",
    estado: "ACTIVE",
    descripcion: null,
    donde: { direccion: null, distrito: null, ciudad: "Ica" },
    comercial: {
      precioDesde: 26500, precioHasta: null, moneda: "PEN", inicialDesde: 3000, cuotaDesde: null,
      plazoMeses: null, financiamiento: "Inicial desde S/ 3,000 · 48 meses sin intereses", rangoAreas: null,
      unidades: null, dormitorios: null,
      financiamientoLotes: { inicial: 3000, mesesLote: 48, mesesCasa: 70, sinIntereses: true },
    },
    puntosVenta: [],
    lotes: [
      { id: "A-01", mz: "A", area: 200, estado: "libre", precio: 59168, precioContado: 52168, moneda: "PEN", promocion: null },
      { id: "A-12", mz: "A", area: 210, estado: "separado", precio: 60000, precioContado: 53000, moneda: "PEN", promocion: null },
      { id: "B-01", mz: "B", area: 250, estado: "libre", precio: 60344.87, precioContado: 53344.87, moneda: "PEN", promocion: { contado: 29900, financiado: 39900 } },
      { id: "Ñ-03", mz: "Ñ", area: 300, estado: "vendido", precio: null, precioContado: null, moneda: "PEN", promocion: null },
      { id: "A-24-bis", mz: "A", area: 180, estado: "libre", precio: 40000, precioContado: null, moneda: "PEN", promocion: null },
    ],
    unidades: null,
    ...over,
  };
}

const catalogo = (...proyectos: ProyectoDeGolden[]): CatalogoDeGolden => ({
  generado: "2026-11-20T00:00:00Z",
  contacto: { whatsapp: null, correo: null, oficina: null },
  proyectos,
});

describe("leerCodigoLote", () => {
  it("entiende como escriben los asesores", () => {
    for (const t of ["A-12", "a12", "A 12", "Mz A lote 12", "Mz. A Lt. 12", "manzana a, lote 12", "A-012"]) {
      expect(leerCodigoLote(t), t).toEqual({ mz: "A", numero: 12, bis: false });
    }
    expect(leerCodigoLote("ñ3")).toEqual({ mz: "Ñ", numero: 3, bis: false });
    expect(leerCodigoLote("A-24 bis")).toEqual({ mz: "A", numero: 24, bis: true });
    expect(leerCodigoLote("hola")).toBeNull();
  });
});

describe("buscarLotes", () => {
  it("encuentra un lote escrito de otra forma y da su precio exacto", () => {
    const r = buscarLotes(catalogo(proyecto()), { lote: "mz a lote 1" });
    expect(r.lotes).toHaveLength(1);
    expect(r.lotes[0]).toMatchObject({ lote: "A-01", estado: "libre", precio_lista: "S/ 59,168", precio_contado: "S/ 52,168" });
  });

  it("con un codigo pedido devuelve el lote aunque no este libre", () => {
    const r = buscarLotes(catalogo(proyecto()), { lote: "A12" });
    expect(r.lotes[0]).toMatchObject({ lote: "A-12", estado: "separado" });
  });

  it("cuenta por estado y lista primero los libres", () => {
    const r = buscarLotes(catalogo(proyecto()), { proyecto: "colinas i" });
    expect(r.por_estado).toEqual({ libre: 3, separado: 1, vendido: 1 });
    expect(r.lotes.every((l) => l.estado === "libre")).toBe(true);
  });

  it("filtra por estado pedido", () => {
    const r = buscarLotes(catalogo(proyecto()), { estado: "vendido" });
    expect(r.lotes.map((l) => l.lote)).toEqual(["Ñ-03"]);
  });

  it("un proyecto que no existe no devuelve 'cero libres': dice cuales hay", () => {
    const r = buscarLotes(catalogo(proyecto()), { proyecto: "Villa Sol" });
    expect(r.proyecto_no_encontrado).toBe(true);
    expect(r.proyectos_disponibles).toEqual(["Las Colinas del Este — Etapa I (Colinas I)"]);
  });

  it("acepta 'Colinas 1' por 'Colinas I'", () => {
    const r = buscarLotes(catalogo(proyecto()), { proyecto: "Colinas 1", lote: "A-01" });
    expect(r.lotes).toHaveLength(1);
  });

  it("muestra la promocion de un lote libre", () => {
    const r = buscarLotes(catalogo(proyecto()), { lote: "B-01" });
    expect(r.lotes[0].promocion).toEqual({ precio_contado: "S/ 29,900", precio_financiado: "S/ 39,900" });
  });

  it("si el mismo codigo esta en dos proyectos, devuelve los dos", () => {
    const otro = proyecto({ id: "colinas-2", nombre: "Colinas II", nombreCorto: "Colinas II" });
    const r = buscarLotes(catalogo(proyecto(), otro), { lote: "A-01" });
    expect(r.lotes.map((l) => l.proyecto)).toEqual(["Colinas I", "Colinas II"]);
  });
});

describe("cuotas", () => {
  it("cuotaLote: misma cuenta que la app (prueba de paridad)", () => {
    expect(cuotaLote({ precio: 59168, inicial: 3000, meses: 48 })).toBe(1170.17);
    expect(cuotaLote({ precio: 30000, inicial: 0, meses: 48 })).toBe(625);
    expect(cuotaLote({ precio: 2000, inicial: 3000, meses: 48 })).toBeNull();
  });

  it("cuotaFrancesa: misma cuenta que el simulador de la app", () => {
    // 200 000 a 15 años con TEA 9.5 %: i = 1.095^(1/12) - 1
    expect(cuotaFrancesa({ capital: 200000, meses: 180, tea: 9.5 })).toBeCloseTo(2041.62, 1);
    expect(cuotaFrancesa({ capital: 120000, meses: 120, tea: 0 })).toBe(1000);
  });
});

describe("simularCuotas", () => {
  it("lote: usa su precio financiado, la inicial y los meses del proyecto, sin intereses", () => {
    const r = simularCuotas(catalogo(proyecto()), { lote: "A-01" });
    expect(r).toMatchObject({
      lote: "A-01", precio_financiado: "S/ 59,168", inicial: "S/ 3,000", meses: 48,
      cuota: "S/ 1,170.17", sin_intereses: true, al_contado: "S/ 52,168",
    });
  });

  it("lote con promocion: da tambien la cuota con el precio de promocion", () => {
    const r = simularCuotas(catalogo(proyecto()), { lote: "B-01", inicial: 3000, meses: 48 });
    expect(r.con_promocion).toMatchObject({ precio_financiado: "S/ 39,900", cuota: "S/ 768.75" });
  });

  it("si el proyecto no tiene plazo configurado, no lo inventa: lo pide", () => {
    const sinPlazo = proyecto();
    sinPlazo.comercial.financiamientoLotes = { inicial: 1000, mesesLote: null, mesesCasa: null, sinIntereses: true };
    const r = simularCuotas(catalogo(sinPlazo), { lote: "A-01" });
    expect(r.error).toMatch(/plazo/i);
    expect(r.financiamiento_del_proyecto).toContain("48 meses");
    expect(simularCuotas(catalogo(sinPlazo), { lote: "A-01", meses: 70 })).toMatchObject({ meses: 70, inicial: "S/ 1,000" });
  });

  it("un lote vendido no se simula como si se pudiera vender", () => {
    const r = simularCuotas(catalogo(proyecto()), { lote: "Ñ-03" });
    expect(r.error).toMatch(/vendido/);
  });

  it("casa o departamento: credito con TEA, y sin TEA no inventa la tasa", () => {
    const casa = proyecto({ id: "casa-lux", nombre: "Casa Lux", nombreCorto: "Casa Lux", categoria: "casa", lotes: null });
    casa.comercial.precioDesde = 250000;
    expect(simularCuotas(catalogo(casa), { proyecto: "casa lux" }).error).toMatch(/TEA/);
    const r = simularCuotas(catalogo(casa), { proyecto: "casa lux", tea: 9.5, inicial_porcentaje: 20, meses: 180 });
    expect(r).toMatchObject({ tipo: "credito_hipotecario", precio: "S/ 250,000", inicial: "S/ 50,000", meses: 180, cuota: "S/ 2,041.62" });
  });
});
