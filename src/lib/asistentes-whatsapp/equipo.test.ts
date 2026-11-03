import { beforeEach, describe, expect, it, vi } from "vitest";

// Una base en memoria: tablas como arreglos y filtros por igualdad. Las
// funciones de caja (cash_as_user) se simulan aparte, porque sus reglas ya
// se prueban contra PostgreSQL en Golden Caja (whatsapp.database.test.ts).
type Fila = Record<string, unknown>;
const tablas: Record<string, Fila[]> = {};
const rpc = vi.fn();

function consulta(tabla: string) {
  const filtros: [string, unknown][] = [];
  const desde: [string, string][] = [];
  let operacion: "select" | "update" | "delete" = "select";
  let cambios: Fila = {};
  let limite = Infinity;
  const filas = () =>
    (tablas[tabla] ??= []).filter(
      (f) => filtros.every(([k, v]) => f[k] === v) && desde.every(([k, v]) => String(f[k] ?? "") >= v),
    );
  const q = {
    select: () => q,
    eq: (k: string, v: unknown) => (filtros.push([k, v]), q),
    gte: (k: string, v: string) => (desde.push([k, v]), q),
    order: () => q,
    limit: (n: number) => ((limite = n), q),
    update: (c: Fila) => ((operacion = "update"), (cambios = c), q),
    delete: () => ((operacion = "delete"), q),
    insert: (nuevas: Fila | Fila[]) => {
      let ultima: Fila = {};
      for (const fila of [nuevas].flat()) {
        ultima = {
          id: crypto.randomUUID(),
          status: "pending",
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          ...fila,
        };
        (tablas[tabla] ??= []).push(ultima);
      }
      return {
        select: () => ({ single: async () => ({ data: ultima, error: null }) }),
        then: (r: (v: unknown) => void) => r({ error: null }),
      };
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
      // Como en PostgreSQL: un update devuelve las filas que cumplían el filtro antes de cambiar.
      const tocadas = filas();
      if (operacion === "update") tocadas.forEach((f) => Object.assign(f, cambios));
      if (operacion === "delete") tablas[tabla] = (tablas[tabla] ?? []).filter((f) => !tocadas.includes(f));
      resolver({ data: tocadas.slice(0, limite), error: null });
    },
  };
  return q;
}

vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({ from: consulta, rpc }) }));
const sendTextMessage = vi.fn<(a: { text: string }) => Promise<{ messageId: string }>>(async () => ({ messageId: "out" }));
const sendInteractiveButtons = vi.fn<(a: { buttons: { id: string }[] }) => Promise<{ messageId: string }>>(async () => ({
  messageId: "out",
}));
const sendMediaMessage = vi.fn<(a: Record<string, unknown>) => Promise<{ messageId: string }>>(async () => ({ messageId: "out" }));
vi.mock("@/lib/whatsapp/meta-api", () => ({ sendTextMessage, sendInteractiveButtons, sendMediaMessage }));
const sendMessageToConversation = vi.fn<
  (db: unknown, cuenta: string, p: Record<string, unknown>) => Promise<{ messageId: string; whatsappMessageId: string }>
>(async () => ({ messageId: "00000000-0000-0000-0000-0000000000aa", whatsappMessageId: "wamid.x" }));
vi.mock("@/lib/whatsapp/send-message", () => ({ sendMessageToConversation }));
const transcribirAudioDeWhatsApp = vi.fn(async () => "gasto de 120 soles en gas para el restaurante por yape");
vi.mock("@/lib/ai/transcribir", () => ({ transcribirAudioDeWhatsApp }));
const conversar = vi.fn();
const responder = vi.fn();
vi.mock("@/lib/assistant/run", () => ({ conversar, responder, ErrorAsistente: class extends Error {} }));
// La sesión de la persona (Golden App y Legal) usa la misma base en memoria.
const rpcPersona = vi.fn();
vi.mock("./sesion", () => ({ clienteDeLaPersona: async () => ({ from: consulta, rpc: rpcPersona }) }));

const { atenderEquipo, PAUSA_PARA_REINICIAR_MS } = await import("./equipo");
const { __resetRateLimitForTests } = await import("@/lib/rate-limit");

const BRYCE = "00000000-0000-0000-0000-000000000001";
const GOLDEN = "00000000-0000-0000-0000-000000000011";
const MENU = ["modo:caja", "modo:app", "modo:legal"];
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
const fotoLegal = {
  accountName: "Golden Habitat",
  role: "owner",
  summary: { pendingReservations: 2, approvedReservations: 5, activeDossiers: 3, totalContracts: 4 },
  pendingReservations: [],
  approvedReservations: [],
  dossiers: [],
  contracts: [],
};

let n = 0;
const escribe = (mensaje: Record<string, unknown>) =>
  atenderEquipo({
    mensaje: { id: `wamid.${++n}`, from: "51940421629", type: "text", ...mensaje },
    accountId: GOLDEN,
    phoneNumberId: "pn",
    accessToken: "tok",
  });
const toca = (id: string) => escribe({ type: "interactive", interactive: { button_reply: { id, title: id } } });
const textos = () => sendTextMessage.mock.calls.map(([a]) => a.text);
const botones = () => sendInteractiveButtons.mock.calls.at(-1)?.[0].buttons.map((b) => b.id);
const sesion = () => tablas.whatsapp_team_sessions[0];

beforeEach(() => {
  for (const k of Object.keys(tablas)) delete tablas[k];
  vi.clearAllMocks();
  __resetRateLimitForTests();
  conversar.mockReset();
  rpc.mockImplementation(async (nombre: string, args: { p_phone?: string; p_call?: string }) => {
    if (nombre === "whatsapp_team_member") {
      return { data: args.p_phone === "51940421629" ? [{ user_id: BRYCE, name: "Bryce" }] : [], error: null };
    }
    if (args.p_call === "overview") return { data: vista, error: null };
    if (args.p_call === "entry") return { data: "entrada-1", error: null };
    return { data: null, error: { message: "no simulado" } };
  });
  rpcPersona.mockResolvedValue({ data: fotoLegal, error: null });
  tablas.legal_enabled_accounts = [{ account_id: GOLDEN }];
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

  it("un hola muestra el menú con los tres asistentes", async () => {
    expect(await escribe({ text: { body: "Hola" } })).toBe(true);
    expect(botones()).toEqual(MENU);
    expect(conversar).not.toHaveBeenCalled();
  });

  it("sin Golden Legal encendido, el menú no lo ofrece", async () => {
    tablas.legal_enabled_accounts = [];
    await escribe({ text: { body: "hola" } });
    expect(botones()).toEqual(["modo:caja", "modo:app"]);
  });

  it("elegir Caja saluda con el resumen y contesta lo que había preguntado", async () => {
    conversar.mockResolvedValueOnce("La cafetería va bien.");
    await escribe({ text: { body: "¿cómo va la cafetería?" } });
    expect(botones()).toEqual(MENU);
    expect(conversar).not.toHaveBeenCalled();
    await toca("modo:caja");
    expect(textos()[0]).toContain("Hola, Bryce. Esto es lo que pasó hoy en Restaurante:");
    expect(conversar.mock.calls[0][0].pregunta).toBe("¿cómo va la cafetería?");
    expect(textos().at(-1)).toBe("💼 Caja\nLa cafetería va bien.");
    expect(sesion()).toMatchObject({ mode: "caja", pending_question: null });
  });

  it("después de una hora sin escribir vuelve el menú y la memoria empieza de cero", async () => {
    await escribe({ text: { body: "hola" } });
    await toca("modo:caja");
    conversar.mockResolvedValue("ok");
    await escribe({ text: { body: "¿saldo?" } });
    expect(conversar).toHaveBeenCalledTimes(1);

    sesion().last_inbound_at = new Date(Date.now() - PAUSA_PARA_REINICIAR_MS - 60_000).toISOString();
    // La memoria vieja queda guardada, pero antes del nuevo comienzo.
    for (const m of tablas.whatsapp_team_messages) m.created_at = "2026-01-01T00:00:00.000Z";
    sendInteractiveButtons.mockClear();
    await escribe({ text: { body: "¿y los gastos?" } });
    expect(botones()).toEqual(MENU);
    expect(conversar).toHaveBeenCalledTimes(1);

    await toca("modo:caja");
    expect(conversar).toHaveBeenCalledTimes(2);
    expect(conversar.mock.calls[1][0].pregunta).toBe("¿y los gastos?");
    expect(conversar.mock.calls[1][0].historial).toEqual([]);
  });

  it("Golden App contesta con el Asistente Golden y su mismo hilo", async () => {
    tablas.profiles = [{ user_id: BRYCE, account_id: GOLDEN, account_role: "owner", full_name: "Bryce Bueno", area: null }];
    responder.mockResolvedValueOnce({ texto: "Tienes **3** clientes calientes.", acciones: [] });
    await escribe({ text: { body: "hola" } });
    await toca("modo:app");
    await toca("app:asistente");
    await escribe({ text: { body: "¿a quién sigo hoy?" } });
    expect(responder.mock.calls[0][0]).toMatchObject({ userId: BRYCE, accountId: GOLDEN, rol: "owner" });
    expect(textos().at(-1)).toBe("🏠 App\nTienes *3* clientes calientes.");
    expect(tablas.assistant_messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("Golden Legal saluda con su resumen y sólo consulta", async () => {
    await escribe({ text: { body: "hola" } });
    await toca("modo:legal");
    expect(textos().at(-1)).toContain("2 separaciones pendientes");
    conversar.mockResolvedValueOnce("No hay pendientes de Ana.");
    await escribe({ text: { body: "¿cómo va la separación de Ana?" } });
    const herramientas = conversar.mock.calls[0][0].herramientas.map((h: { function: { name: string } }) => h.function.name);
    expect(herramientas).toEqual(["panorama_legal", "buscar_cliente_legal", "contratos"]);
    expect(textos().at(-1)).toBe("⚖️ Legal\nNo hay pendientes de Ana.");
  });

  it("una nota de voz arma un borrador y sólo el botón lo guarda", async () => {
    await escribe({ text: { body: "hola" } });
    await toca("modo:caja");
    conversar.mockImplementation(async (o: { ejecutar: (n: string, a: string) => Promise<unknown>; pregunta: string }) => {
      expect(o.pregunta).toContain("gas para el restaurante");
      await o.ejecutar(
        "proponer_movimiento",
        JSON.stringify({ caja: "restaurante", tipo: "gasto", monto: 120, concepto: "Gas", metodo: "yape" }),
      );
      return "Revisa el borrador y toca Sí, guardar.";
    });
    await escribe({ type: "audio", audio: { id: "media-1" } });
    const botonSi = botones()![0];
    expect(botonSi).toMatch(/^caja:si:/);
    expect(tablas.whatsapp_team_drafts[0].command).toMatchObject({
      companyId: "c1",
      amountCents: 12000,
      kind: "expense",
      paymentMethod: "yape",
    });

    // Un "sí" escrito no guarda: va a la IA como cualquier texto.
    conversar.mockReset();
    conversar.mockResolvedValueOnce("Para guardarlo toca el botón Sí, guardar.");
    await escribe({ text: { body: "sí" } });
    expect(rpc.mock.calls.some(([, a]) => a.p_call === "entry")).toBe(false);

    await toca(botonSi);
    const guardados = rpc.mock.calls.filter(([, a]) => a.p_call === "entry");
    expect(guardados).toHaveLength(1);
    expect(guardados[0][1]).toMatchObject({ p_user: BRYCE });
    expect(textos().at(-1)).toContain("Listo: −S/ 120 en Restaurante · Gas · Yape");
    expect(tablas.whatsapp_team_drafts[0]).toMatchObject({ status: "saved", result_id: "entrada-1" });

    // Tocar otra vez no guarda dos veces.
    await toca(botonSi);
    expect(rpc.mock.calls.filter(([, a]) => a.p_call === "entry")).toHaveLength(1);
    expect(textos().at(-1)).toContain("Ese ya quedó guardado");
  });

  it("un gasto grande pide justificación antes del borrador", async () => {
    await escribe({ text: { body: "hola" } });
    await toca("modo:caja");
    sendInteractiveButtons.mockClear();
    let respuesta: unknown;
    conversar.mockImplementation(async (o: { ejecutar: (n: string, a: string) => Promise<unknown> }) => {
      respuesta = await o.ejecutar(
        "proponer_movimiento",
        JSON.stringify({ caja: "Restaurante", tipo: "gasto", monto: 900, concepto: "Horno" }),
      );
      return "¿Por qué fue este gasto?";
    });
    await escribe({ text: { body: "gasto de 900 en horno para el restaurante" } });
    expect(respuesta).toMatchObject({ falta: "justificacion" });
    expect(sendInteractiveButtons).not.toHaveBeenCalled();
  });

  it("al tocar Golden App elige escribir como cliente o como asistente", async () => {
    await escribe({ text: { body: "hola" } });
    await toca("modo:app");
    expect(botones()).toEqual(["app:cliente", "app:asistente"]);
    expect(sesion().mode).toBeNull();

    await toca("app:cliente");
    expect(sesion().mode).toBe("cliente");
    expect(await escribe({ text: { body: "hola, quiero un lote" } })).toBe(false);
    expect(responder).not.toHaveBeenCalled();

    expect(await escribe({ text: { body: "/salir" } })).toBe(true);
    expect(botones()).toEqual(MENU);
  });

  it("con /cliente se le atiende como cliente hasta /salir", async () => {
    await escribe({ text: { body: "/cliente" } });
    expect(await escribe({ text: { body: "quiero un lote" } })).toBe(false);
    expect(await escribe({ text: { body: "/salir" } })).toBe(true);
    expect(botones()).toEqual(MENU);
  });

  it("un encargado con un solo asistente entra directo, sin menú", async () => {
    rpc.mockImplementation(async (nombre: string, args: { p_call?: string }) =>
      nombre === "whatsapp_team_member"
        ? { data: [{ user_id: BRYCE, name: "Lucero" }], error: null }
        : args.p_call === "overview"
          ? { data: { ...vista, isOwner: false }, error: null }
          : { data: null, error: null },
    );
    await escribe({ text: { body: "hola" } });
    expect(sendInteractiveButtons).not.toHaveBeenCalled();
    expect(textos()[0]).toContain("Hola, Lucero. Esto es lo que pasó hoy");
  });

  describe("el material de los proyectos", () => {
    const DRAFT = "00000000-0000-0000-0000-0000000000d1";
    const CONV = "00000000-0000-0000-0000-0000000000c1";
    const brochure = {
      tipo: "brochure", kind: "document", url: "https://golden.test/b.pdf",
      nombre: "Brochure Casa Jade.pdf", etiqueta: "Brochure de Casa Jade", comoEnlace: false,
    };
    const video = {
      tipo: "video", kind: "video", url: "https://golden.test/v.mp4",
      nombre: "Video Casa Jade.mp4", etiqueta: "Video de Casa Jade", comoEnlace: false,
    };
    const enlace = { ...video, url: "https://golden.test/r.mp4", etiqueta: "Video de Rinconada", comoEnlace: true };
    const propuesta = { cliente: "Juan", telefono: "+51999", asesor: "Sara", etiquetas: ["Brochure de Casa Jade", "Video de Casa Jade"], mensaje: "Mira esto" };

    const entrarAlAsistente = async () => {
      tablas.profiles = [{ user_id: BRYCE, account_id: GOLDEN, account_role: "owner", full_name: "Bryce Bueno", area: null }];
      await escribe({ text: { body: "hola" } });
      await toca("app:asistente");
      sendInteractiveButtons.mockClear();
      sendTextMessage.mockClear();
    };
    const dejarBorrador = (cambios: Fila = {}) => {
      tablas.whatsapp_team_drafts = [{
        id: DRAFT, account_id: GOLDEN, user_id: BRYCE, status: "pending",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        summary: JSON.stringify(propuesta),
        command: { tipo: "envio_cliente", conversacionId: CONV, canal: "whatsapp", adjuntos: [brochure, video], mensaje: "Mira esto" },
        ...cambios,
      }];
      tablas.messages = [{ conversation_id: CONV, sender_type: "customer", created_at: new Date(Date.now() - 3_600_000).toISOString() }];
    };

    it("pedir un brochure manda primero el texto y después el archivo", async () => {
      await entrarAlAsistente();
      responder.mockResolvedValueOnce({ texto: "Ahí va.", acciones: [], adjuntos: [brochure], envios: [] });
      await escribe({ text: { body: "mándame el brochure de casa jade" } });
      expect(textos().at(-1)).toBe("🏠 App\nAhí va.");
      expect(sendMediaMessage).toHaveBeenCalledWith(
        expect.objectContaining({ to: "51940421629", kind: "document", link: brochure.url, filename: brochure.nombre }),
      );
      expect(sendTextMessage.mock.invocationCallOrder[0]).toBeLessThan(sendMediaMessage.mock.invocationCallOrder[0]);
    });

    it("un video que WhatsApp no acepta por su peso va como enlace", async () => {
      await entrarAlAsistente();
      responder.mockResolvedValueOnce({ texto: "Ahí va.", acciones: [], adjuntos: [enlace], envios: [] });
      await escribe({ text: { body: "mándame el video de rinconada" } });
      expect(sendMediaMessage).not.toHaveBeenCalled();
      expect(textos().at(-1)).toContain("https://golden.test/r.mp4");
    });

    it("si el archivo falla, lo dice en vez de quedarse callado", async () => {
      await entrarAlAsistente();
      sendMediaMessage.mockRejectedValueOnce(new Error("Meta dijo que no"));
      responder.mockResolvedValueOnce({ texto: "Ahí va.", acciones: [], adjuntos: [brochure], envios: [] });
      await escribe({ text: { body: "mándame el brochure" } });
      expect(textos().at(-1)).toContain("No pude enviar Brochure de Casa Jade");
    });

    it("un envío a un cliente sólo muestra la tarjeta: no sale nada", async () => {
      await entrarAlAsistente();
      responder.mockResolvedValueOnce({ texto: "Revisa la tarjeta.", acciones: [], adjuntos: [], envios: [{ id: DRAFT, ...propuesta }] });
      await escribe({ text: { body: "envíale el brochure a juan" } });
      expect(sendMessageToConversation).not.toHaveBeenCalled();
      expect(botones()).toEqual([`envio:si:${DRAFT}`, `envio:cancelar:${DRAFT}`]);
      const tarjeta = sendInteractiveButtons.mock.calls.at(-1)?.[0] as unknown as { bodyText: string };
      for (const dato of ["Juan", "+51999", "Sara", "Brochure de Casa Jade", "Video de Casa Jade", "Mira esto"]) {
        expect(tarjeta.bodyText).toContain(dato);
      }
    });

    it("el botón envía cada archivo, con el texto sólo en el primero", async () => {
      await entrarAlAsistente();
      dejarBorrador();
      await toca(`envio:si:${DRAFT}`);
      expect(sendMessageToConversation).toHaveBeenCalledTimes(2);
      expect(sendMessageToConversation.mock.calls[0][1]).toBe(GOLDEN);
      expect(sendMessageToConversation.mock.calls[0][2]).toMatchObject({
        conversationId: CONV, messageType: "document", mediaUrl: brochure.url, filename: brochure.nombre, contentText: "Mira esto",
      });
      expect(sendMessageToConversation.mock.calls[1][2]).toMatchObject({ messageType: "video", mediaUrl: video.url, contentText: null });
      expect(tablas.whatsapp_team_drafts[0].status).toBe("saved");
      expect(textos().at(-1)).toContain("Listo");
      expect(tablas.assistant_messages.at(-1)?.content).toContain("Juan");
    });

    it("tocar dos veces envía una sola vez", async () => {
      await entrarAlAsistente();
      dejarBorrador();
      await toca(`envio:si:${DRAFT}`);
      await toca(`envio:si:${DRAFT}`);
      expect(sendMessageToConversation).toHaveBeenCalledTimes(2);
      expect(textos().at(-1)).toContain("ya salió");
    });

    it("el borrador se reserva antes de enviar", async () => {
      await entrarAlAsistente();
      dejarBorrador();
      sendMessageToConversation.mockImplementationOnce(async () => {
        expect(tablas.whatsapp_team_drafts[0].status).toBe("saved");
        return { messageId: "00000000-0000-0000-0000-0000000000aa", whatsappMessageId: "w" };
      });
      await toca(`envio:si:${DRAFT}`);
      expect(sendMessageToConversation).toHaveBeenCalled();
    });

    it("vencido no envía", async () => {
      await entrarAlAsistente();
      dejarBorrador({ expires_at: new Date(Date.now() - 1000).toISOString() });
      await toca(`envio:si:${DRAFT}`);
      expect(sendMessageToConversation).not.toHaveBeenCalled();
      expect(textos().at(-1)).toContain("venció");
      expect(tablas.whatsapp_team_drafts[0].status).toBe("cancelled");
    });

    it("si la ventana se cerró entre la tarjeta y el toque, no envía y lo avisa", async () => {
      await entrarAlAsistente();
      dejarBorrador();
      tablas.messages[0].created_at = new Date(Date.now() - 25 * 3_600_000).toISOString();
      await toca(`envio:si:${DRAFT}`);
      expect(sendMessageToConversation).not.toHaveBeenCalled();
      expect(textos().at(-1)).toContain("24 h");
      expect(tablas.whatsapp_team_drafts[0].status).toBe("cancelled");
    });

    it("cancelar no envía", async () => {
      await entrarAlAsistente();
      dejarBorrador();
      await toca(`envio:cancelar:${DRAFT}`);
      expect(sendMessageToConversation).not.toHaveBeenCalled();
      expect(tablas.whatsapp_team_drafts[0].status).toBe("cancelled");
    });

    it("el borrador de otra persona no se puede tocar", async () => {
      await entrarAlAsistente();
      dejarBorrador({ user_id: "00000000-0000-0000-0000-000000000002" });
      await toca(`envio:si:${DRAFT}`);
      expect(sendMessageToConversation).not.toHaveBeenCalled();
      expect(tablas.whatsapp_team_drafts[0].status).toBe("pending");
    });

    it("un botón de caja sobre un envío no registra plata", async () => {
      await entrarAlAsistente();
      dejarBorrador();
      await toca(`caja:si:${DRAFT}`);
      expect(rpc.mock.calls.some(([, a]) => a.p_call === "entry")).toBe(false);
      expect(tablas.whatsapp_team_drafts[0].status).toBe("pending");
    });

    it("si falla a medias, dice qué salió y qué no", async () => {
      await entrarAlAsistente();
      dejarBorrador();
      sendMessageToConversation
        .mockResolvedValueOnce({ messageId: "00000000-0000-0000-0000-0000000000aa", whatsappMessageId: "w" })
        .mockRejectedValueOnce(new Error("Meta dijo que no"));
      await toca(`envio:si:${DRAFT}`);
      expect(textos().at(-1)).toContain("Salió: Brochure de Casa Jade");
      expect(textos().at(-1)).toContain("No salió: Video de Casa Jade");
      expect(tablas.whatsapp_team_drafts[0].status).toBe("failed");
    });
  });

  it("alguien del equipo sin ningún asistente sigue como cliente", async () => {
    rpc.mockImplementation(async (nombre: string) =>
      nombre === "whatsapp_team_member"
        ? { data: [{ user_id: BRYCE, name: "Bryce" }], error: null }
        : { data: { ...vista, isOwner: false, boxes: [] }, error: null },
    );
    expect(await escribe({ text: { body: "hola" } })).toBe(false);
  });
});
