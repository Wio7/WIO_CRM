import { afterEach, describe, expect, it, vi } from "vitest";

import {
  armarAvisoSeparacion,
  consultarAvisoSeparacion,
  consultarSeparacionAprobada,
  esEvento,
  esUuid,
  instanteDelEvento,
  solicitudReciente,
} from "./aviso-separacion";

const ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOLDEN_SUPABASE_URL;
  delete process.env.GOLDEN_SUPABASE_ANON_KEY;
});

describe("armarAvisoSeparacion", () => {
  const base = { proyecto: "colinas-2", nombreProyecto: "Colinas 2", lote: "H-26", asesor: "Carlos Merino" };

  it("dice proyecto, lote y asesor, y abre el plano del proyecto", () => {
    const a = armarAvisoSeparacion(base);
    expect(a.title).toBe("Lote separado");
    expect(a.body).toBe("Colinas 2 · H-26 (Carlos Merino)");
    expect(a.url).toBe("/#/lotes/colinas-2");
    expect(a.tag).toBe("separacion-colinas-2-H-26");
  });

  it("los tres eventos: textos y etiqueta de cada uno, mismo cuerpo", () => {
    const e = (evento: "solicitada" | "aprobada" | "vendida") => armarAvisoSeparacion({ ...base, evento });
    expect(e("solicitada")).toEqual({
      title: "Lote en proceso",
      body: "Colinas 2 · H-26 (Carlos Merino)",
      url: "/#/lotes/colinas-2",
      tag: "separacion-colinas-2-H-26-solicitada",
    });
    expect(e("aprobada")).toEqual({
      title: "Lote separado",
      body: "Colinas 2 · H-26 (Carlos Merino)",
      url: "/#/lotes/colinas-2",
      tag: "separacion-colinas-2-H-26",
    });
    expect(e("vendida")).toEqual({
      title: "Lote vendido",
      body: "Colinas 2 · H-26 (Carlos Merino)",
      url: "/#/lotes/colinas-2",
      tag: "separacion-colinas-2-H-26-vendida",
    });
  });

  it("sin evento se entiende aprobada (compatibilidad con el cliente actual)", () => {
    expect(armarAvisoSeparacion(base).title).toBe("Lote separado");
  });

  it("sin asesor no deja paréntesis vacíos", () => {
    expect(armarAvisoSeparacion({ ...base, asesor: "" }).body).toBe("Colinas 2 · H-26");
  });

  it("sin nombre de proyecto usa el id", () => {
    expect(armarAvisoSeparacion({ ...base, nombreProyecto: "" }).body).toContain("colinas-2 · H-26");
  });

  it("limpia saltos de línea y recorta textos largos", () => {
    const a = armarAvisoSeparacion({ ...base, asesor: "Ana\n\nPérez " + "x".repeat(200) });
    expect(a.body).not.toMatch(/\n/);
    expect(a.body.length).toBeLessThanOrEqual(140);
  });

  it("no tiene dónde llevar datos del cliente", () => {
    const a = armarAvisoSeparacion({ ...base, cliente_nombre: "Juan", cliente_documento: "12345678" } as never);
    expect(JSON.stringify(a)).not.toMatch(/Juan|12345678/);
  });
});

describe("esEvento / instanteDelEvento", () => {
  it("sólo existen tres eventos", () => {
    for (const e of ["solicitada", "aprobada", "vendida"]) expect(esEvento(e)).toBe(true);
    for (const e of ["", "rechazada", undefined, 3, "APROBADA"]) expect(esEvento(e)).toBe(false);
  });
  it("la vigencia se mide desde el instante de cada etapa", () => {
    const s = { proyecto: "p", lote: "l", asesor: "a", creada: "C", resuelta: "R", actualizado: "A" };
    expect(instanteDelEvento(s, "solicitada")).toBe("C");
    expect(instanteDelEvento(s, "aprobada")).toBe("R");
    expect(instanteDelEvento(s, "vendida")).toBe("A");
    expect(instanteDelEvento({ proyecto: "p", lote: "l", asesor: "a", resuelta: null }, "vendida")).toBeNull();
  });
});

describe("esUuid / solicitudReciente", () => {
  it("acepta uuid y rechaza lo demás", () => {
    expect(esUuid(ID)).toBe(true);
    expect(esUuid("1; drop table")).toBe(false);
    expect(esUuid(undefined)).toBe(false);
  });

  it("sólo vale una aprobación de los últimos 15 minutos", () => {
    const ahora = Date.parse("2026-11-11T09:30:00Z");
    expect(solicitudReciente("2026-11-11T09:20:00Z", ahora)).toBe(true);
    expect(solicitudReciente("2026-11-11T08:00:00Z", ahora)).toBe(false);
    expect(solicitudReciente(null, ahora)).toBe(false);
    expect(solicitudReciente("basura", ahora)).toBe(false);
  });
});

describe("consultarSeparacionAprobada", () => {
  it("sin variables de entorno devuelve sin_config", async () => {
    expect(await consultarSeparacionAprobada(ID)).toEqual({ estado: "sin_config" });
  });

  it("llama al RPC del catálogo con la clave pública y devuelve la solicitud aprobada", async () => {
    process.env.GOLDEN_SUPABASE_URL = "https://cat.test/";
    process.env.GOLDEN_SUPABASE_ANON_KEY = "anon";
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify([{ proyecto: "colinas-2", lote: "H-26", asesor: "Carlos", resuelta: "2026-11-11T09:29:00Z" }]),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const r = await consultarSeparacionAprobada(ID);
    expect(r).toEqual({
      estado: "aprobada",
      solicitud: { proyecto: "colinas-2", lote: "H-26", asesor: "Carlos", resuelta: "2026-11-11T09:29:00Z" },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cat.test/rest/v1/rpc/gh_aviso_separacion");
    expect(JSON.parse(init.body as string)).toEqual({ p_solicitud: ID, p_evento: "aprobada" });
  });

  it("pasa el evento pedido al RPC", async () => {
    process.env.GOLDEN_SUPABASE_URL = "https://cat.test";
    process.env.GOLDEN_SUPABASE_ANON_KEY = "anon";
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    for (const evento of ["solicitada", "vendida"] as const) {
      expect(await consultarAvisoSeparacion(ID, evento)).toEqual({ estado: "no_aprobada" });
    }
    const cuerpos = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(cuerpos).toEqual([
      { p_solicitud: ID, p_evento: "solicitada" },
      { p_solicitud: ID, p_evento: "vendida" },
    ]);
  });

  it("si la solicitud no está aprobada (lista vacía) devuelve no_aprobada", async () => {
    process.env.GOLDEN_SUPABASE_URL = "https://cat.test";
    process.env.GOLDEN_SUPABASE_ANON_KEY = "anon";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    expect(await consultarSeparacionAprobada(ID)).toEqual({ estado: "no_aprobada" });
  });

  it("si la base responde error devuelve error (nunca avisa por las dudas)", async () => {
    process.env.GOLDEN_SUPABASE_URL = "https://cat.test";
    process.env.GOLDEN_SUPABASE_ANON_KEY = "anon";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    expect(await consultarSeparacionAprobada(ID)).toEqual({ estado: "error" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("red"); }));
    expect(await consultarSeparacionAprobada(ID)).toEqual({ estado: "error" });
  });
});
