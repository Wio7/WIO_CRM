import { beforeEach, describe, expect, it, vi } from "vitest";

type Fila = Record<string, unknown>;
const tablas: Record<string, Fila[]> = {};
const rpc = vi.fn();

function consulta(tabla: string) {
  const filtros: [string, unknown][] = [];
  let nueva: Fila | null = null;
  const filas = () => (tablas[tabla] ??= []).filter((f) => filtros.every(([k, v]) => f[k] === v));
  const q = {
    select: () => q,
    eq: (k: string, v: unknown) => (filtros.push([k, v]), q),
    in: () => q,
    gte: () => q,
    lt: () => q,
    lte: () => q,
    is: () => q,
    order: () => q,
    limit: () => q,
    range: () => q,
    ilike: () => q,
    or: () => q,
    insert: (f: Fila) => {
      nueva = { id: "borrador-1", ...f };
      (tablas[tabla] ??= []).push(nueva);
      return q;
    },
    single: async () => ({ data: nueva, error: null }),
    maybeSingle: async () => ({ data: filas()[0] ?? null, error: null }),
    then: (r: (v: unknown) => void) => r({ data: filas(), error: null }),
  };
  return q;
}

const db = { from: consulta, rpc };
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => db }));
vi.mock("@/lib/push/send", () => ({ notifyClient: vi.fn() }));
vi.mock("@/lib/agenda/slots", () => ({ diasLibres: vi.fn() }));

const catalogoDeGolden = vi.fn();
vi.mock("@/lib/golden/catalogo", () => ({ catalogoDeGolden }));

const leerSeparaciones = vi.fn();
vi.mock("@/lib/golden/ventas", async (original) => ({
  ...(await original<typeof import("@/lib/golden/ventas")>()),
  leerSeparaciones,
}));

const { ejecutarHerramienta } = await import("./tools");

const CUENTA = "cuenta";
const ctx = (cambios: Record<string, unknown> = {}) =>
  ({ db, userId: "bryce", accountId: CUENTA, rol: "owner", area: null, nombre: "Bryce", canal: "whatsapp", ...cambios }) as never;
const usar = async (nombre: string, args: unknown, contexto = ctx()) =>
  ejecutarHerramienta(contexto, nombre, JSON.stringify(args)) as Promise<{
    datos: Record<string, never>;
    adjuntos?: { url: string }[];
    envio?: { id: string; cliente: string; asesor: string | null; etiquetas: string[]; mensaje: string | null };
  }>;

const jade = {
  id: "casa-jade",
  nombre: "Casa Jade",
  nombreCorto: null,
  media: {
    brochure: { ruta: "/b.pdf", bytes: 1000 },
    video: { ruta: "/v.mp4", bytes: 1000 },
    foto: null,
  },
};
const colinas = { id: "colinas", nombre: "Colinas", nombreCorto: null, media: { brochure: null, video: null, foto: null } };
const reciente = () => new Date(Date.now() - 3_600_000).toISOString();

beforeEach(() => {
  for (const k of Object.keys(tablas)) delete tablas[k];
  vi.clearAllMocks();
  vi.stubEnv("GOLDEN_APP_URL", "https://golden.test");
  catalogoDeGolden.mockResolvedValue({
    proyectos: [jade, colinas],
    combi: { horarios: { 5: ["09:00", "11:30"] }, provisional: true },
  });
  leerSeparaciones.mockResolvedValue({ estado: "ok", filas: [], estados: new Map() });
  rpc.mockResolvedValue({ data: [], error: null });
  tablas.contacts = [{ id: "juan", name: "Juan", phone: "+51999", account_id: CUENTA }];
  tablas.conversations = [{ id: "conv", account_id: CUENTA, contact_id: "juan", channel: "whatsapp", assigned_agent_id: "sara" }];
  tablas.messages = [{ conversation_id: "conv", sender_type: "customer", created_at: reciente() }];
  tablas.profiles = [{ id: "p-sara", user_id: "sara", full_name: "Sara Ríos", email: "sara@g.pe", account_role: "agent", account_id: CUENTA }];
});

describe("enviar_material", () => {
  it("a quien pregunta le llegan los archivos, sin borrador", async () => {
    const r = await usar("enviar_material", { proyecto: "jade", tipos: ["brochure", "brochure", "video"] });
    expect(r.adjuntos?.map((a) => a.url)).toEqual(["https://golden.test/b.pdf", "https://golden.test/v.mp4"]);
    expect(tablas.whatsapp_team_drafts).toBeUndefined();
  });

  it("en la app da enlaces, porque no hay archivos que mandar", async () => {
    const r = await usar("enviar_material", { proyecto: "jade", tipos: ["brochure"] }, ctx({ canal: "app" }));
    expect(r.adjuntos).toBeUndefined();
    expect(r.datos.enlaces).toEqual([{ que: "Brochure de Casa Jade", enlace: "https://golden.test/b.pdf" }]);
  });

  it("en la app no se le envía nada a un cliente: no hay botón", async () => {
    const r = await usar("enviar_material", { proyecto: "jade", tipos: ["brochure"], cliente: "Juan" }, ctx({ canal: "app" }));
    expect(r.datos.error).toBeDefined();
    expect(tablas.whatsapp_team_drafts).toBeUndefined();
  });

  it("a un cliente sólo arma el borrador, con lo que verá el dueño", async () => {
    const r = await usar("enviar_material", { proyecto: "jade", tipos: ["brochure"], cliente: "Juan", mensaje: "Mira esto" });
    expect(r.adjuntos).toBeUndefined();
    expect(r.envio).toMatchObject({ id: "borrador-1", cliente: "Juan", etiquetas: ["Brochure de Casa Jade"], mensaje: "Mira esto" });
    expect(tablas.whatsapp_team_drafts[0].command).toMatchObject({ tipo: "envio_cliente", conversacionId: "conv", canal: "whatsapp", mensaje: "Mira esto" });
    expect(tablas.whatsapp_team_drafts[0]).toMatchObject({ account_id: CUENTA, user_id: "bryce" });
  });

  it("con la ventana cerrada no hay borrador", async () => {
    tablas.messages[0].created_at = new Date(Date.now() - 25 * 3_600_000).toISOString();
    const r = await usar("enviar_material", { proyecto: "jade", tipos: ["brochure"], cliente: "Juan" });
    expect(r.datos.ventana_cerrada).toBe(true);
    expect(r.envio).toBeUndefined();
    expect(tablas.whatsapp_team_drafts).toBeUndefined();
  });

  it("por la app del cliente no aplica la ventana de WhatsApp", async () => {
    tablas.conversations[0].channel = "app";
    tablas.messages = [];
    const r = await usar("enviar_material", { proyecto: "jade", tipos: ["brochure"], cliente: "Juan" });
    expect(r.envio).toBeDefined();
  });

  it("quien nunca escribió no tiene a dónde recibirlo", async () => {
    tablas.conversations = [];
    const r = await usar("enviar_material", { proyecto: "jade", tipos: ["brochure"], cliente: "Juan" });
    expect(r.datos.sin_conversacion).toBe(true);
  });

  it("con varios clientes parecidos pregunta cuál", async () => {
    tablas.contacts.push({ id: "juan2", name: "Juan Pérez", phone: "+51888", account_id: CUENTA });
    const r = await usar("enviar_material", { proyecto: "jade", tipos: ["brochure"], cliente: "Jua" });
    expect(r.datos.ambiguo).toBe(true);
    expect(tablas.whatsapp_team_drafts).toBeUndefined();
  });

  it("si el proyecto no tiene ese material, dice qué sí tiene", async () => {
    const sin = await usar("enviar_material", { proyecto: "colinas", tipos: ["brochure"] });
    expect(sin.datos).toMatchObject({ sin_material: true, tiene: [] });
    const foto = await usar("enviar_material", { proyecto: "jade", tipos: ["foto"] });
    expect(foto.datos).toMatchObject({ sin_material: true, tiene: ["brochure", "video"] });
  });

  it("un proyecto que no existe no manda nada: ofrece la lista", async () => {
    const r = await usar("enviar_material", { proyecto: "zzz", tipos: ["brochure"] });
    expect(r.datos.opciones).toEqual(["Casa Jade", "Colinas"]);
  });

  it("un texto de más de 1024 caracteres no se corta a escondidas", async () => {
    const r = await usar("enviar_material", { proyecto: "jade", tipos: ["brochure"], cliente: "Juan", mensaje: "a".repeat(1025) });
    expect(r.datos.error).toContain("1024");
    expect(tablas.whatsapp_team_drafts).toBeUndefined();
  });

  it("sin la dirección de la app lo dice", async () => {
    vi.stubEnv("GOLDEN_APP_URL", "");
    const r = await usar("enviar_material", { proyecto: "jade", tipos: ["brochure"] });
    expect(r.datos.error).toContain("GOLDEN_APP_URL");
  });
});

describe("rendimiento_del_equipo", () => {
  const separacion = (lote: string, asesor: string, precio: number | null = 50000) => ({
    proyecto: "colinas",
    lote,
    asesor,
    moneda: "PEN",
    monto: 1000,
    precio_lote: precio,
    resuelta: new Date().toISOString(),
  });
  const conVentas = (...filas: ReturnType<typeof separacion>[]) =>
    leerSeparaciones.mockResolvedValue({
      estado: "ok",
      filas,
      estados: new Map(filas.map((f) => [`colinas|${f.lote}`, "separado"])),
    });

  beforeEach(() => {
    tablas.profiles.push({ id: "p-ana", user_id: "ana", full_name: "Ana Flores", email: "ana@g.pe", account_role: "agent", account_id: CUENTA });
    rpc.mockImplementation(async (nombre: string) =>
      nombre === "actividad_del_equipo"
        ? { data: [{ user_id: "ana", recibidos: 40, enviados: 30, chats: 5, dias: ["2026-10-10"] }], error: null }
        : { data: [], error: null },
    );
  });

  it("un asesor no puede verlo", async () => {
    const r = await usar("rendimiento_del_equipo", {}, ctx({ rol: "agent" }));
    expect(r.datos.error).toBeDefined();
    expect(leerSeparaciones).not.toHaveBeenCalled();
  });

  it("gana quien vendió, aunque otro mueva más mensajes", async () => {
    conVentas(separacion("A-1", "Sara"));
    const r = await usar("rendimiento_del_equipo", {});
    expect(r.datos.mejor_vendedor).toBe("Sara Ríos");
    const ranking = r.datos.ranking as unknown as { nombre: string; ventas: unknown; mensajes: unknown }[];
    expect(ranking.map((p) => p.nombre)).toEqual(["Sara Ríos", "Ana Flores"]);
    expect(ranking[0].ventas).toMatchObject({ cantidad: 1, importes: { PEN: 50000 } });
    expect(ranking[1].mensajes).toEqual({ recibidos: 40, enviados: 30 });
  });

  it("sin la clave no nombra a nadie como el mejor, y dice qué falta", async () => {
    leerSeparaciones.mockResolvedValue({ estado: "sin_clave" });
    const r = await usar("rendimiento_del_equipo", {});
    expect(r.datos.mejor_vendedor).toBeNull();
    expect(r.datos.ventas_no_disponibles).toContain("GOLDEN_SUPABASE_SERVICE_KEY");
  });

  it("si la base de la app falla tampoco nombra a nadie", async () => {
    leerSeparaciones.mockResolvedValue({ estado: "error" });
    const r = await usar("rendimiento_del_equipo", {});
    expect(r.datos.mejor_vendedor).toBeNull();
    expect(r.datos.ventas_no_disponibles).toBeDefined();
  });

  it("si nadie vendió, no hay mejor vendedor", async () => {
    expect((await usar("rendimiento_del_equipo", {})).datos.mejor_vendedor).toBeNull();
  });

  it("un nombre que no se puede atribuir no se pierde ni se le da a otro", async () => {
    conVentas(separacion("A-1", "Pedrito"));
    const r = await usar("rendimiento_del_equipo", {});
    expect(r.datos.mejor_vendedor).toBeNull();
    expect(r.datos.sin_coincidir).toEqual([expect.objectContaining({ escrito_como: "Pedrito", cantidad: 1 })]);
  });

  it("sin la migración 080, los mensajes no se reportan como cero", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "no existe" } });
    const r = await usar("rendimiento_del_equipo", {});
    expect(r.datos.falta_migracion).toContain("080");
    expect((r.datos.ranking as unknown as { mensajes: unknown }[])[0].mensajes).toBeNull();
  });

  it("una cita cumplida sigue contando", async () => {
    tablas.appointments = [{ user_id: "sara", status: "cumplida", starts_at: new Date().toISOString(), account_id: CUENTA }];
    const r = await usar("rendimiento_del_equipo", {});
    const sara = (r.datos.ranking as unknown as { nombre: string; citas: unknown; indice_actividad: number }[]).find((p) => p.nombre === "Sara Ríos");
    expect(sara?.citas).toEqual({ total: 1, cumplidas: 1, canceladas: 0 });
  });

  it("de un asesor concreto da su detalle", async () => {
    conVentas(separacion("A-1", "Sara"));
    const r = await usar("rendimiento_del_equipo", { asesor: "sara" });
    expect(r.datos).toMatchObject({ nombre: "Sara Ríos", puesto: 1 });
    expect(r.datos.ventas_detalle).toHaveLength(1);
    expect(r.datos.ranking).toBeUndefined();
  });

  it("si no reconoce al asesor, devuelve el equipo para preguntar", async () => {
    const r = await usar("rendimiento_del_equipo", { asesor: "Golden 1" });
    expect(r.datos.asesor_no_encontrado).toBe("Golden 1");
    expect(r.datos.equipo).toEqual(["Ana Flores", "Sara Ríos"]);
  });

  it("no le pasa los ids internos al modelo", async () => {
    conVentas(separacion("A-1", "Sara"));
    const r = await usar("rendimiento_del_equipo", {});
    expect(JSON.stringify(r.datos)).not.toContain('"userId"');
  });
});

describe("quien_esta_activo", () => {
  it("un asesor no puede verlo", async () => {
    expect((await usar("quien_esta_activo", {}, ctx({ rol: "agent" }))).datos.error).toBeDefined();
  });

  it("dice quién está ahora y cuántos clientes entraron", async () => {
    tablas.member_presence = [{ user_id: "sara", last_seen_at: new Date().toISOString(), account_id: CUENTA }];
    tablas.client_sessions = [
      { contact_id: "x", account_id: CUENTA },
      { contact_id: "x", account_id: CUENTA },
      { contact_id: "y", account_id: CUENTA },
    ];
    const r = await usar("quien_esta_activo", {});
    expect(r.datos.conectados_ahora).toEqual(["Sara Ríos"]);
    expect(r.datos.clientes_que_abrieron_la_app_en_24_h).toBe(2);
  });
});

describe("combi_del_dia", () => {
  it("da las salidas con sus pasajeros y los horarios sin salida", async () => {
    tablas.combi_salidas = [{ id: "s1", account_id: CUENTA, fecha: "2026-10-30", hora: "09:00:00", proyecto: "Colinas", capacidad: 10 }];
    rpc.mockResolvedValue({ data: [{ numero: 1, tipo: "cliente", nombre: "Ana", telefono: null, asesor_nombre: "Sara", asistencia: null }], error: null });
    const r = await usar("combi_del_dia", { fecha: "2026-10-30" });
    expect(rpc).toHaveBeenCalledWith("combi_mapa", { p_salida: "s1" });
    expect(r.datos.salidas).toEqual([expect.objectContaining({ hora: "09:00", libres: 9, pasajeros: [expect.objectContaining({ nombre: "Ana", asesor: "Sara" })] })]);
    expect(r.datos.programados_sin_pasajeros).toEqual(["11:30"]);
    expect(r.datos.horarios_provisionales).toBe(true);
  });

  it("sólo dueños y administradores ven la bitácora del conductor", async () => {
    tablas.combi_novedades = [{ tipo: "falla", texto: "Llanta", resuelta: false, account_id: CUENTA }];
    expect((await usar("combi_del_dia", {})).datos.novedades_del_conductor).toHaveLength(1);
    expect((await usar("combi_del_dia", {}, ctx({ rol: "agent" }))).datos.novedades_del_conductor).toEqual([]);
  });

  it("una fecha mal escrita usa la de hoy", async () => {
    const r = await usar("combi_del_dia", { fecha: "mañana" });
    expect(r.datos.fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
