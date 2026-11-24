import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  armarAvisoSeparacion,
  asesorDeSolicitud,
  consultarAvisoSeparacion,
  esEvento,
  esUuid,
  instanteDelEvento,
  solicitudReciente,
} from "./aviso-separacion";

const ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  vi.restoreAllMocks();
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

describe("consultarAvisoSeparacion", () => {
  const base = (respuesta: unknown) => {
    const rpc = vi.fn(async () => respuesta);
    return { db: { rpc } as unknown as SupabaseClient, rpc };
  };

  it("pregunta a la base con el evento pedido y devuelve la solicitud", async () => {
    const fila = { proyecto: "colinas-2", lote: "H-26", asesor: "Carlos", resuelta: "2026-11-11T09:29:00Z" };
    const { db, rpc } = base({ data: [fila], error: null });
    expect(await consultarAvisoSeparacion(db, ID, "vendida")).toEqual({ estado: "aprobada", solicitud: fila });
    expect(rpc).toHaveBeenCalledWith("gh_aviso_separacion", { p_solicitud: ID, p_evento: "vendida" });
  });

  it("lista vacía: no_aprobada; error o caída: error (nunca avisa por las dudas)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await consultarAvisoSeparacion(base({ data: [], error: null }).db, ID)).toEqual({ estado: "no_aprobada" });
    expect(await consultarAvisoSeparacion(base({ data: null, error: { message: "x" } }).db, ID)).toEqual({ estado: "error" });
    const caida = { rpc: async () => { throw new Error("red"); } } as unknown as SupabaseClient;
    expect(await consultarAvisoSeparacion(caida, ID)).toEqual({ estado: "error" });
  });
});

describe("asesorDeSolicitud", () => {
  const base = (uid: string | null, perfil: object | null) =>
    ({
      from: (t: string) => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: t === "profiles" ? perfil : { asesor_uid: uid } }) }),
        }),
      }),
    }) as unknown as SupabaseClient;

  it("devuelve al asesor sólo si es miembro de la misma cuenta y no de solo lectura", async () => {
    expect(await asesorDeSolicitud(base("a", { account_id: "acc", account_role: "agent" }), ID, "acc")).toBe("a");
    expect(await asesorDeSolicitud(base("a", { account_id: "otra", account_role: "agent" }), ID, "acc")).toBeNull();
    expect(await asesorDeSolicitud(base("a", { account_id: "acc", account_role: "viewer" }), ID, "acc")).toBeNull();
    expect(await asesorDeSolicitud(base("a", null), ID, "acc")).toBeNull();
    expect(await asesorDeSolicitud(base(null, null), ID, "acc")).toBeNull();
  });
});
