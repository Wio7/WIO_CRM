import { beforeEach, describe, expect, it, vi } from "vitest";

// Una base en memoria: tablas como arreglos y filtros por igualdad. Las
// funciones de caja (cash_as_user) se simulan aparte, porque sus reglas ya
// se prueban contra PostgreSQL en Golden Caja (whatsapp.database.test.ts).
type Fila = Record<string, unknown>;
const tablas: Record<string, Fila[]> = {};
const rpc = vi.fn();

function consulta(tabla: string) {
  const filtros: [string, unknown][] = [];
  let operacion: "select" | "update" | "delete" = "select";
  let cambios: Fila = {};
  let limite = Infinity;
  const filas = () => (tablas[tabla] ??= []).filter((f) => filtros.every(([k, v]) => f[k] === v));
  const q = {
    select: () => q,
    eq: (k: string, v: unknown) => (filtros.push([k, v]), q),
    order: () => q,
    limit: (n: number) => ((limite = n), q),
    update: (c: Fila) => ((operacion = "update"), (cambios = c), q),
    delete: () => ((operacion = "delete"), q),
    insert: (fila: Fila) => {
      const nueva = { id: crypto.randomUUID(), status: "pending", expires_at: new Date(Date.now() + 600_000).toISOString(), ...fila };
      (tablas[tabla] ??= []).push(nueva);
      return { select: () => ({ single: async () => ({ data: nueva, error: null }) }), then: (r: (v: unknown) => void) => r({ error: null }) };
    },
    upsert: async (fila: Fila) => {
      const lista = (tablas[tabla] ??= []);
      const previa = lista.find((f) => f.account_id === fila.account_id && f.user_id === fila.user_id);
      if (previa) Object.assign(previa, fila);
      else lista.push({ ...fila });
      return { error: null };
    },
    maybeSingle: async () => ({ data: filas()[0] ?? null, error: null }),
    then: (resolver: (v: unknown) => void) => {
      if (operacion === "update") filas().forEach((f) => Object.assign(f, cambios));
      if (operacion === "delete") tablas[tabla] = (tablas[tabla] ?? []).filter((f) => !filas().includes(f));
      resolver({ data: filas().slice(0, limite), error: null });
    },
  };
  return q;
}

vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({ from: consulta, rpc }) }));
const sendTextMessage = vi.fn<(a: { text: string }) => Promise<{ messageId: string }>>(async () => ({ messageId: "out" }));
const sendInteractiveButtons = vi.fn<(a: { buttons: { id: string }[] }) => Promise<{ messageId: string }>>(async () => ({ messageId: "out" }));
vi.mock("@/lib/whatsapp/meta-api", () => ({ sendTextMessage, sendInteractiveButtons }));
const transcribirAudioDeWhatsApp = vi.fn(async () => "gasto de 120 soles en gas para el restaurante por yape");
vi.mock("@/lib/ai/transcribir", () => ({ transcribirAudioDeWhatsApp }));
const conversar = vi.fn();
vi.mock("@/lib/assistant/run", () => ({ conversar, ErrorAsistente: class extends Error {} }));

const { atenderEquipo } = await import("./equipo");

const BRYCE = "00000000-0000-0000-0000-000000000001";
const GOLDEN = "00000000-0000-0000-0000-000000000011";
const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
const vista = {
  day: hoy,
  isOwner: true,
  accountName: "Golden Habitat",
  boxes: [
    { id: "c1", name: "Restaurante", icon: "🍽️", largeExpenseCents: 50000, balanceCents: 0, inCents: 0, outCents: 0,
      transferInCents: 0, transferOutCents: 0, count: 0, largeExpenses: [], closure: null, pendingReplenishments: [] },
  ],
};

let n = 0;
const escribe = (mensaje: Record<string, unknown>) =>
  atenderEquipo({
    mensaje: { id: `wamid.${++n}`, from: "51999888777", type: "text", ...mensaje },
    accountId: GOLDEN,
    phoneNumberId: "pn",
    accessToken: "tok",
  });
const textos = () => sendTextMessage.mock.calls.map(([a]) => a.text);

beforeEach(() => {
  for (const k of Object.keys(tablas)) delete tablas[k];
  vi.clearAllMocks();
  rpc.mockImplementation(async (nombre: string, args: { p_phone?: string; p_call?: string }) => {
    if (nombre === "whatsapp_team_member") {
      return { data: args.p_phone === "51999888777" ? [{ user_id: BRYCE, name: "Bryce" }] : [], error: null };
    }
    if (args.p_call === "overview") return { data: vista, error: null };
    if (args.p_call === "entry") return { data: "entrada-1", error: null };
    return { data: null, error: { message: "no simulado" } };
  });
});

describe("el equipo en el número de WhatsApp", () => {
  it("a un cliente no lo toca", async () => {
    const atendido = await atenderEquipo({
      mensaje: { id: "x", from: "51900000000", type: "text", text: { body: "hola" } },
      accountId: GOLDEN,
      phoneNumberId: "pn",
      accessToken: "tok",
    });
    expect(atendido).toBe(false);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("al primer saludo del día le manda el resumen y no llama a la IA", async () => {
    expect(await escribe({ text: { body: "Hola" } })).toBe(true);
    expect(textos()[0]).toContain("Hola, Bryce. Esto es lo que pasó hoy en Restaurante:");
    expect(conversar).not.toHaveBeenCalled();
  });

  it("una nota de voz arma un borrador y sólo el botón lo guarda", async () => {
    conversar.mockImplementation(async (o: { ejecutar: (n: string, a: string) => Promise<unknown>; pregunta: string }) => {
      expect(o.pregunta).toContain("gas para el restaurante");
      await o.ejecutar("proponer_movimiento", JSON.stringify({ caja: "restaurante", tipo: "gasto", monto: 120, concepto: "Gas", metodo: "yape" }));
      return "Revisa el borrador y toca Sí, guardar.";
    });
    await escribe({ type: "audio", audio: { id: "media-1" } });
    expect(sendInteractiveButtons).toHaveBeenCalledTimes(1);
    const botonSi = sendInteractiveButtons.mock.calls[0][0].buttons[0].id;
    expect(botonSi).toMatch(/^caja:si:/);
    expect(tablas.whatsapp_team_drafts[0].command).toMatchObject({ companyId: "c1", amountCents: 12000, kind: "expense", paymentMethod: "yape" });

    // Un "sí" escrito no guarda: va a la IA como cualquier texto.
    conversar.mockResolvedValueOnce("Para guardarlo toca el botón Sí, guardar.");
    await escribe({ text: { body: "sí" } });
    expect(rpc.mock.calls.some(([, a]) => a.p_call === "entry")).toBe(false);

    await escribe({ type: "interactive", interactive: { button_reply: { id: botonSi, title: "✅ Sí, guardar" } } });
    const guardados = rpc.mock.calls.filter(([, a]) => a.p_call === "entry");
    expect(guardados).toHaveLength(1);
    expect(guardados[0][1]).toMatchObject({ p_user: BRYCE });
    expect(textos().at(-1)).toContain("Listo: −S/ 120 en Restaurante · Gas · Yape");
    expect(tablas.whatsapp_team_drafts[0]).toMatchObject({ status: "saved", result_id: "entrada-1" });

    // Tocar otra vez no guarda dos veces.
    await escribe({ type: "interactive", interactive: { button_reply: { id: botonSi, title: "✅ Sí, guardar" } } });
    expect(rpc.mock.calls.filter(([, a]) => a.p_call === "entry")).toHaveLength(1);
    expect(textos().at(-1)).toContain("Ese ya quedó guardado");
  });

  it("un gasto grande pide justificación antes del borrador", async () => {
    let respuesta: unknown;
    conversar.mockImplementation(async (o: { ejecutar: (n: string, a: string) => Promise<unknown> }) => {
      respuesta = await o.ejecutar("proponer_movimiento", JSON.stringify({ caja: "Restaurante", tipo: "gasto", monto: 900, concepto: "Horno" }));
      return "¿Por qué fue este gasto?";
    });
    await escribe({ text: { body: "gasto de 900 en horno para el restaurante" } });
    expect(respuesta).toMatchObject({ falta: "justificacion" });
    expect(sendInteractiveButtons).not.toHaveBeenCalled();
  });

  it("con /cliente se le atiende como cliente hasta /salir", async () => {
    await escribe({ text: { body: "/cliente" } });
    expect(await escribe({ text: { body: "quiero un lote" } })).toBe(false);
    expect(await escribe({ text: { body: "/salir" } })).toBe(true);
    expect(textos().at(-1)).toContain("Esto es lo que pasó hoy");
  });

  it("alguien del equipo sin cajas a la vista sigue como cliente", async () => {
    rpc.mockImplementation(async (nombre: string) =>
      nombre === "whatsapp_team_member"
        ? { data: [{ user_id: BRYCE, name: "Bryce" }], error: null }
        : { data: { ...vista, boxes: [] }, error: null },
    );
    expect(await escribe({ text: { body: "hola" } })).toBe(false);
  });
});
