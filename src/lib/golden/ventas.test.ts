import { afterEach, describe, expect, it, vi } from "vitest";

import { emparejarAsesor, leerSeparaciones, ventasDeSeparaciones, type FilaSeparacion } from "./ventas";

const fila = (cambios: Partial<FilaSeparacion> = {}): FilaSeparacion => ({
  proyecto: "colinas-1",
  lote: "A-1",
  asesor: "Sara",
  moneda: "PEN",
  monto: 1000,
  precio_lote: 50000,
  resuelta: "2026-10-15T15:00:00.000Z",
  ...cambios,
});
const OCTUBRE = { desde: "2026-10-01T05:00:00.000Z", hasta: "2026-11-01T05:00:00.000Z" };
const estados = (...vigentes: [string, string, string][]) =>
  new Map(vigentes.map(([p, l, e]) => [`${p}|${l}`, e]));

describe("ventasDeSeparaciones", () => {
  it("cuenta las aprobadas de un lote separado o vendido", () => {
    const filas = [fila(), fila({ lote: "A-2" })];
    expect(
      ventasDeSeparaciones(filas, estados(["colinas-1", "A-1", "separado"], ["colinas-1", "A-2", "vendido"]), OCTUBRE),
    ).toHaveLength(2);
  });

  it("un lote que se liberó no cuenta", () => {
    expect(ventasDeSeparaciones([fila()], estados(), OCTUBRE)).toEqual([]);
    expect(ventasDeSeparaciones([fila()], estados(["colinas-1", "A-1", "libre"]), OCTUBRE)).toEqual([]);
  });

  it("si un lote se aprobó dos veces, cuenta sólo la última", () => {
    const vieja = fila({ asesor: "Ana", resuelta: "2026-10-02T15:00:00.000Z" });
    const nueva = fila({ asesor: "Sara", resuelta: "2026-10-20T15:00:00.000Z" });
    const r = ventasDeSeparaciones([vieja, nueva], estados(["colinas-1", "A-1", "separado"]), OCTUBRE);
    expect(r.map((f) => f.asesor)).toEqual(["Sara"]);
  });

  it("la venta anterior a la última no reaparece en su propio periodo", () => {
    const vieja = fila({ asesor: "Ana", resuelta: "2026-09-02T15:00:00.000Z" });
    const nueva = fila({ asesor: "Sara", resuelta: "2026-10-20T15:00:00.000Z" });
    const setiembre = { desde: "2026-09-01T05:00:00.000Z", hasta: "2026-10-01T05:00:00.000Z" };
    expect(ventasDeSeparaciones([vieja, nueva], estados(["colinas-1", "A-1", "separado"]), setiembre)).toEqual([]);
  });

  it("fuera del periodo no cuenta, y el límite de arriba queda fuera", () => {
    const vigente = estados(["colinas-1", "A-1", "separado"]);
    expect(ventasDeSeparaciones([fila({ resuelta: "2026-09-30T15:00:00.000Z" })], vigente, OCTUBRE)).toEqual([]);
    expect(ventasDeSeparaciones([fila({ resuelta: OCTUBRE.hasta })], vigente, OCTUBRE)).toEqual([]);
    expect(ventasDeSeparaciones([fila({ resuelta: OCTUBRE.desde })], vigente, OCTUBRE)).toHaveLength(1);
  });

  it("una aprobada sin fecha no se puede ubicar en un periodo", () => {
    expect(ventasDeSeparaciones([fila({ resuelta: null })], estados(["colinas-1", "A-1", "separado"]), OCTUBRE)).toEqual([]);
  });
});

describe("emparejarAsesor", () => {
  const equipo = [
    { user_id: "sara", full_name: "Sara Ríos", email: "sara@golden.pe" },
    { user_id: "ana1", full_name: "Ana Flores", email: "ana.flores@golden.pe" },
    { user_id: "ana2", full_name: "Ana Quispe", email: "aquispe@golden.pe" },
    { user_id: "g1", full_name: "Golden 1", email: "golden1@golden.pe" },
    { user_id: "correo", full_name: null, email: "marco@golden.pe" },
  ];

  it("reconoce el nombre sin importar tildes ni mayúsculas", () => {
    expect(emparejarAsesor("SARA RIOS", equipo)).toBe("sara");
  });

  it("reconoce un nombre a medias si sólo le queda a uno", () => {
    expect(emparejarAsesor("Sara", equipo)).toBe("sara");
    expect(emparejarAsesor("Flores", equipo)).toBe("ana1");
  });

  it("con dos candidatos no adivina", () => {
    expect(emparejarAsesor("Ana", equipo)).toBeNull();
  });

  it("escrito con más palabras que su nombre del equipo, también es él", () => {
    expect(emparejarAsesor("Marco Antonio Soto", [{ user_id: "m", full_name: "Marco Soto", email: null }])).toBe("m");
  });

  it("reconoce 'Golden 1' por nombre y por correo", () => {
    expect(emparejarAsesor("golden 1", equipo)).toBe("g1");
    expect(emparejarAsesor("Golden1", equipo)).toBe("g1");
  });

  it("usa el correo de quien no tiene nombre", () => {
    expect(emparejarAsesor("Marco", equipo)).toBe("correo");
  });

  it("sin coincidencia, o con una sola letra, no devuelve a nadie", () => {
    expect(emparejarAsesor("Pedro", equipo)).toBeNull();
    expect(emparejarAsesor("A", equipo)).toBeNull();
    expect(emparejarAsesor("   ", equipo)).toBeNull();
  });
});

describe("leerSeparaciones", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sin la clave dice que falta y no llama a nadie", async () => {
    vi.stubEnv("GOLDEN_SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("GOLDEN_SUPABASE_SERVICE_KEY", "");
    const pedir = vi.fn();
    vi.stubGlobal("fetch", pedir);
    expect(await leerSeparaciones()).toEqual({ estado: "sin_clave" });
    expect(pedir).not.toHaveBeenCalled();
  });

  it("lee todas las páginas y nunca pide datos del cliente", async () => {
    vi.stubEnv("GOLDEN_SUPABASE_URL", "https://x.supabase.co/");
    vi.stubEnv("GOLDEN_SUPABASE_SERVICE_KEY", "clave");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      const pagina = new URL(url).searchParams.get("offset") === "0" ? 1000 : 3;
      const fila = url.includes("gh_lotes_estado")
        ? { proyecto: "p", lote: "l", estado: "separado" }
        : fila0;
      return new Response(JSON.stringify(Array.from({ length: pagina }, () => fila)), { status: 200 });
    }));
    const r = await leerSeparaciones();
    expect(r.estado).toBe("ok");
    if (r.estado !== "ok") return;
    expect(r.filas).toHaveLength(1003);
    expect(r.estados.get("p|l")).toBe("separado");
    expect(urls.every((u) => u.startsWith("https://x.supabase.co/rest/v1/"))).toBe(true);
    for (const u of urls) expect(u).not.toMatch(/cliente_|voucher|operacion|observaciones|select=\*/);
  });

  it("si la base falla lo dice, no devuelve una lista vacía", async () => {
    vi.stubEnv("GOLDEN_SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("GOLDEN_SUPABASE_SERVICE_KEY", "clave");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    expect(await leerSeparaciones()).toEqual({ estado: "error" });
  });
});

const fila0 = fila();
