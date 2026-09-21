import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  catalogoDeGolden,
  catalogoEnTexto,
  olvidarCatalogo,
  sinCatalogoPegado,
  type CatalogoDeGolden,
} from "./catalogo";

const APP = "https://golden.example";
const SB = "https://app-db.example";

/** El catálogo tal como lo publica la app, recortado a lo justo. */
function publicado(): CatalogoDeGolden {
  return {
    generado: "2026-09-21T00:00:00.000Z",
    contacto: { whatsapp: "+51 959 251 023", correo: null, oficina: null },
    proyectos: [
      {
        id: "colinas-1",
        nombre: "Las Colinas del Este — Etapa I",
        nombreCorto: "Colinas I",
        lema: "Lotes desde 200 m²",
        categoria: "lotes",
        estado: "ACTIVE",
        descripcion: "Condominio privado.",
        donde: { direccion: "Km 10", distrito: null, ciudad: "Ica" },
        comercial: {
          precioDesde: 26500,
          precioHasta: null,
          moneda: "PEN",
          inicialDesde: 3000,
          cuotaDesde: null,
          plazoMeses: null,
          financiamiento: "Entrega inmediata",
          rangoAreas: "Desde 200 m²",
          unidades: null,
          dormitorios: null,
        },
        puntosVenta: ["Entrega inmediata"],
        lotes: [
          { id: "A-01", mz: "A", area: 200, estado: "libre" },
          { id: "A-02", mz: "A", area: 200, estado: "libre" },
          { id: "B-01", mz: "B", area: 300, estado: "libre" },
        ],
        unidades: null,
      },
    ],
  };
}

/** Un fetch que responde según la URL que le pidan. */
function conRespuestas(mapa: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const clave = Object.keys(mapa).find((k) => String(url).includes(k));
    if (clave === undefined) return { ok: false, status: 404, json: async () => ({}) };
    const valor = mapa[clave];
    if (valor === null) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => valor };
  });
}

beforeEach(() => {
  olvidarCatalogo();
  process.env.GOLDEN_APP_URL = APP;
  process.env.GOLDEN_SUPABASE_URL = SB;
  process.env.GOLDEN_SUPABASE_ANON_KEY = "anon-test";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOLDEN_APP_URL;
  delete process.env.GOLDEN_SUPABASE_URL;
  delete process.env.GOLDEN_SUPABASE_ANON_KEY;
  olvidarCatalogo();
});

describe("catalogoDeGolden", () => {
  it("sin GOLDEN_APP_URL no hay catálogo, y no se rompe nada", async () => {
    delete process.env.GOLDEN_APP_URL;
    expect(await catalogoDeGolden()).toBeNull();
  });

  it("si la app no contesta, devuelve null en vez de un catálogo a medias", async () => {
    vi.stubGlobal("fetch", conRespuestas({ "catalogo-ia.json": null }));
    expect(await catalogoDeGolden()).toBeNull();
  });

  it("el precio que edita marketing gana sobre el compilado", async () => {
    vi.stubGlobal(
      "fetch",
      conRespuestas({
        "catalogo-ia.json": publicado(),
        gh_catalogo: [
          {
            id: "colinas-1",
            nombre: null,
            estado: "ACTIVE",
            precio_desde: 31900,
            precio_hasta: null,
            moneda: "PEN",
            descripcion: null,
            financiamiento: null,
            area_rango: null,
            oculto: false,
          },
        ],
        gh_lotes_estado: [],
      }),
    );
    const c = await catalogoDeGolden();
    expect(c?.proyectos[0].comercial.precioDesde).toBe(31900);
  });

  it("el estado vivo de un lote gana sobre el del plano", async () => {
    vi.stubGlobal(
      "fetch",
      conRespuestas({
        "catalogo-ia.json": publicado(),
        gh_catalogo: [],
        gh_lotes_estado: [
          { proyecto: "colinas-1", lote: "A-01", estado: "vendido", precio: null, moneda: null },
        ],
      }),
    );
    const c = await catalogoDeGolden();
    const lotes = c!.proyectos[0].lotes!;
    expect(lotes.find((l) => l.id === "A-01")!.estado).toBe("vendido");
    // El que la base no menciona conserva el estado del plano.
    expect(lotes.find((l) => l.id === "A-02")!.estado).toBe("libre");
  });

  it("un proyecto oculto en el panel no se le ofrece a nadie", async () => {
    vi.stubGlobal(
      "fetch",
      conRespuestas({
        "catalogo-ia.json": publicado(),
        gh_catalogo: [
          {
            id: "colinas-1",
            nombre: null,
            estado: "ACTIVE",
            precio_desde: null,
            precio_hasta: null,
            moneda: null,
            descripcion: null,
            financiamiento: null,
            area_rango: null,
            oculto: true,
          },
        ],
        gh_lotes_estado: [],
      }),
    );
    expect((await catalogoDeGolden())!.proyectos).toHaveLength(0);
  });

  it("no vuelve a pedirlo todo en cada mensaje", async () => {
    const fetchMock = conRespuestas({
      "catalogo-ia.json": publicado(),
      gh_catalogo: [],
      gh_lotes_estado: [],
    });
    vi.stubGlobal("fetch", fetchMock);
    await catalogoDeGolden();
    const primeras = fetchMock.mock.calls.length;
    await catalogoDeGolden();
    expect(fetchMock.mock.calls.length).toBe(primeras);
  });
});

describe("catalogoEnTexto", () => {
  it("cuenta los lotes libres y los agrupa por manzana", () => {
    const c = publicado();
    c.proyectos[0].lotes![0].estado = "vendido";
    const texto = catalogoEnTexto(c);
    expect(texto).toContain("2 libres de 3");
    expect(texto).toContain("Mz A: 1");
    expect(texto).toContain("Mz B: 1");
    expect(texto).toContain("S/ 26,500");
  });

  it("sin precio lo dice, en vez de dejar al modelo rellenando el hueco", () => {
    const c = publicado();
    c.proyectos[0].comercial.precioDesde = null;
    expect(catalogoEnTexto(c)).toContain("no publicado");
  });

  it("lista las unidades en venta de un edificio", () => {
    const c = publicado();
    c.proyectos[0].lotes = null;
    c.proyectos[0].unidades = [
      { id: "A-2", nombre: "Piso 2", area: 83.35, precio: 249000, terraza: false, disponible: true },
      { id: "A-4", nombre: "Penthouse", area: 119, precio: null, terraza: true, disponible: false },
    ];
    const texto = catalogoEnTexto(c);
    expect(texto).toContain("Piso 2 (83.35 m², S/ 249,000)");
    expect(texto).not.toContain("Penthouse");
  });
});

describe("sinCatalogoPegado", () => {
  it("quita el bloque del script viejo y respeta lo escrito a mano", () => {
    const prompt = [
      "Eres la asistente de Golden. Sé breve.",
      "<<< CATÁLOGO AL DÍA — lo escribe scripts/ia-conocimiento.mjs, no editar a mano >>>",
      "- Colinas I: lotes desde S/ 26,500.",
      "<<< FIN DEL CATÁLOGO >>>",
      "Nunca ofrezcas descuentos.",
    ].join("\n");
    const limpio = sinCatalogoPegado(prompt)!;
    expect(limpio).toContain("Sé breve");
    expect(limpio).toContain("Nunca ofrezcas descuentos");
    expect(limpio).not.toContain("26,500");
  });

  it("un prompt que era sólo catálogo queda en nada, no en basura", () => {
    const prompt =
      "<<< CATÁLOGO AL DÍA — x >>>\n- algo\n<<< FIN DEL CATÁLOGO >>>";
    expect(sinCatalogoPegado(prompt)).toBeNull();
  });

  it("deja intacto un prompt sin marcas", () => {
    expect(sinCatalogoPegado("Sé amable.")).toBe("Sé amable.");
  });
});
