// ============================================================
// Las herramientas del Asistente Golden.
//
// El asistente es un compañero de trabajo para el equipo, no un bot para
// clientes: resume a los clientes de quien le pregunta, mira su agenda,
// busca horas libres, agenda citas, deja notas y dice quién está atrasado.
//
// Todas las consultas corren con el cliente de Supabase DE QUIEN PREGUNTA
// (su JWT), así que la base aplica sus permisos (RLS): un asesor sólo ve
// las conversaciones que le tocan (039), igual que en su bandeja. El
// asistente nunca ve más de lo que la persona ya podía ver.
//
// Cada herramienta devuelve datos compactos (JSON pequeño): el modelo los
// convierte en una respuesta corta para el celular.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { diasLibres } from "@/lib/agenda/slots";
import { catalogoDeGolden } from "@/lib/golden/catalogo";
import { nombreDeCita } from "@/lib/agenda/tipos";
import { notifyClient } from "@/lib/push/send";
import { supabaseAdmin } from "@/lib/flows/admin-client";

export interface ContextoAsistente {
  db: SupabaseClient;
  userId: string;
  accountId: string;
  rol: string;
  area: string | null;
  nombre: string;
}

export interface Accion {
  tipo: "cita_agendada" | "nota_guardada";
  detalle: string;
}

interface Resultado {
  datos: unknown;
  accion?: Accion;
}

// ------------------------------------------------------------
// Definiciones que ve el modelo (formato "tools" de OpenAI)
// ------------------------------------------------------------

export const HERRAMIENTAS = [
  {
    type: "function",
    function: {
      name: "resumen_del_dia",
      description:
        "Lo más urgente de hoy para quien pregunta: chats sin leer, citas de hoy, cuotas atrasadas y vouchers esperando revisión. Úsala cuando pregunte '¿qué tengo hoy?', 'resumen', 'pendientes'.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "mis_clientes",
      description:
        "Lista los clientes/conversaciones que atiende quien pregunta. De cada uno trae lo que el CLIENTE escribió con sus propias palabras (`dijo_el_cliente`), quién habló al final, las señales de interés detectadas, si hay mensajes sin leer y si debe cuotas. Úsala siempre que pregunten por interés, por quién está caliente o a quién seguir.",
      parameters: {
        type: "object",
        properties: {
          filtro: {
            type: "string",
            enum: ["todos", "sin_leer", "atrasados", "sin_responder"],
            description: "sin_responder = el último mensaje es del cliente.",
          },
          solo_mios: {
            type: "boolean",
            description:
              "true = sólo las conversaciones asignadas a quien pregunta. Por defecto: un asesor ve las suyas; un dueño o administrador, las de todo el equipo.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "catalogo",
      description:
        "QUÉ VENDE GOLDEN: los proyectos que hay en la app —casas, lotes y departamentos— con su precio, su ubicación, su financiamiento, cuántos lotes quedan libres de cada tamaño y qué unidades siguen en venta. Úsala SIEMPRE que pregunten por precios, por lo que se ofrece, por qué hay disponible o por qué mandarle a un cliente. No tiene nada que ver con los clientes asignados: contesta aunque la persona no tenga ninguno.",
      parameters: {
        type: "object",
        properties: {
          buscar: {
            type: "string",
            description: "Nombre de un proyecto, o 'casas' / 'lotes' / 'departamentos' para filtrar. Vacío = todo.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "equipo",
      description:
        "Quién es quién en Golden: nombre, rol, área, cuántas conversaciones lleva cada uno y si tiene horarios publicados para que le agenden. Para un dueño o un jefe: cómo está repartido el trabajo.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "resumen_cliente",
      description:
        "Todo sobre un cliente: datos, lo que compró, saldo y atraso, próximas cuotas, vouchers, citas, separaciones, notas y los últimos mensajes del chat. Busca por nombre, teléfono o DNI.",
      parameters: {
        type: "object",
        properties: {
          buscar: { type: "string", description: "Nombre, teléfono o DNI del cliente." },
        },
        required: ["buscar"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mi_agenda",
      description: "Las citas agendadas entre dos fechas (por defecto, hoy y los próximos 7 días). Las de quien pregunta, o las de todo el equipo si lo pide un dueño o un jefe.",
      parameters: {
        type: "object",
        properties: {
          desde: { type: "string", description: "Fecha YYYY-MM-DD (hora de Lima)." },
          hasta: { type: "string", description: "Fecha YYYY-MM-DD (hora de Lima), inclusive." },
          de_todo_el_equipo: {
            type: "boolean",
            description: "true = las citas de todos, con el nombre de quien atiende cada una. Sólo para dueño o administrador.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "horas_libres",
      description:
        "Las horas libres de quien pregunta según sus horarios publicados y sus citas, para proponerle una hora a un cliente.",
      parameters: {
        type: "object",
        properties: {
          dias: { type: "integer", minimum: 1, maximum: 14, description: "Cuántos días hacia adelante (por defecto 7)." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agendar_cita",
      description:
        "Agenda una cita de quien pregunta con un cliente. Llámala SOLO cuando el cliente, el día, la hora y el tipo estén claros y la persona lo haya pedido o confirmado.",
      parameters: {
        type: "object",
        properties: {
          cliente: { type: "string", description: "Nombre, teléfono o DNI del cliente." },
          inicio: {
            type: "string",
            description: "Fecha y hora de inicio en ISO 8601 con zona de Lima, p. ej. 2026-09-21T10:30:00-05:00.",
          },
          tipo: { type: "string", enum: ["videollamada", "visita", "llamada"], description: "visita = presencial en la oficina." },
          minutos: { type: "integer", minimum: 10, maximum: 240 },
          notas: { type: "string" },
        },
        required: ["cliente", "inicio", "tipo"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cuotas_atrasadas",
      description: "Las cuotas vencidas y sin pagar de la cuenta, de la más antigua a la más nueva, con cliente y monto.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "agregar_nota",
      description: "Guarda una nota interna en la ficha de un cliente (no la ve el cliente).",
      parameters: {
        type: "object",
        properties: {
          cliente: { type: "string", description: "Nombre, teléfono o DNI." },
          texto: { type: "string" },
        },
        required: ["cliente", "texto"],
        additionalProperties: false,
      },
    },
  },
] as const;

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------

const LIMA = "America/Lima";

const hoyLima = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: LIMA, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const cuandoLima = (iso: string) =>
  new Intl.DateTimeFormat("es-PE", {
    timeZone: LIMA,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

const esJefe = (rol: string) => rol === "owner" || rol === "admin";

interface ContactoEncontrado {
  id: string;
  name: string | null;
  phone: string | null;
  dni?: string | null;
  email?: string | null;
  lead_source?: string | null;
}

/** Busca un contacto por nombre, teléfono o DNI. Devuelve uno o varios candidatos. */
async function buscarContacto(
  ctx: ContextoAsistente,
  texto: string,
): Promise<{ uno?: ContactoEncontrado; varios?: ContactoEncontrado[] }> {
  const q = texto.trim();
  if (!q) return { varios: [] };
  const digitos = q.replace(/\D/g, "");

  let consulta = ctx.db
    .from("contacts")
    .select("id, name, phone, dni, email, lead_source")
    .eq("account_id", ctx.accountId)
    .limit(6);

  if (digitos.length >= 6) {
    consulta = consulta.or(`phone.ilike.%${digitos.slice(-9)}%,dni.eq.${digitos}`);
  } else {
    const limpio = q.replace(/[%,()]/g, " ").trim();
    consulta = consulta.ilike("name", `%${limpio}%`);
  }

  const { data, error } = await consulta;
  if (error) {
    // Sin la 044 `dni` no existe: se busca sólo por teléfono.
    if (digitos.length >= 6) {
      const { data: d2 } = await ctx.db
        .from("contacts")
        .select("id, name, phone, email")
        .eq("account_id", ctx.accountId)
        .ilike("phone", `%${digitos.slice(-9)}%`)
        .limit(6);
      const lista = (d2 ?? []) as ContactoEncontrado[];
      return lista.length === 1 ? { uno: lista[0] } : { varios: lista };
    }
    return { varios: [] };
  }
  const lista = (data ?? []) as ContactoEncontrado[];
  if (lista.length === 1) return { uno: lista[0] };
  // Si el nombre coincide exacto con uno, ése.
  const exacto = lista.find((c) => (c.name ?? "").toLowerCase() === q.toLowerCase());
  if (exacto) return { uno: exacto };
  return { varios: lista };
}

const candidatos = (varios: ContactoEncontrado[] = []) =>
  varios.length
    ? { ambiguo: true, candidatos: varios.map((c) => ({ nombre: c.name, telefono: c.phone })) }
    : { no_encontrado: true };

// ------------------------------------------------------------
// Herramientas
// ------------------------------------------------------------

async function resumenDelDia(ctx: ContextoAsistente): Promise<Resultado> {
  const hoy = hoyLima();
  const inicio = new Date(`${hoy}T00:00:00-05:00`).toISOString();
  const fin = new Date(`${hoy}T23:59:59-05:00`).toISOString();

  const sinLeerQ = ctx.db
    .from("conversations")
    .select("unread_count, contact:contacts(name, phone)")
    .eq("account_id", ctx.accountId)
    .gt("unread_count", 0);
  // El asesor, lo suyo; el dueño y los administradores, todo.
  if (!esJefe(ctx.rol)) sinLeerQ.eq("assigned_agent_id", ctx.userId);

  const [sinLeer, citas, atrasadas, vouchers] = await Promise.all([
    sinLeerQ
      .order("last_message_at", { ascending: false })
      .limit(10),
    ctx.db
      .from("appointments")
      .select("starts_at, kind, contact:contacts(name, phone)")
      .eq("user_id", ctx.userId)
      .eq("status", "agendada")
      .gte("starts_at", inicio)
      .lte("starts_at", fin)
      .order("starts_at"),
    ctx.db
      .from("installments")
      .select("id", { count: "exact", head: true })
      .eq("account_id", ctx.accountId)
      .eq("status", "pendiente")
      .lt("due_date", hoy),
    ctx.db
      .from("installments")
      .select("id", { count: "exact", head: true })
      .eq("account_id", ctx.accountId)
      .eq("status", "pendiente")
      .not("voucher_path", "is", null),
  ]);

  type ConNombre = { contact: { name: string | null; phone: string | null } | null };
  const nombre = (c: ConNombre) => c.contact?.name || c.contact?.phone || "Cliente";

  return {
    datos: {
      fecha: hoy,
      chats_sin_leer: ((sinLeer.data ?? []) as unknown as (ConNombre & { unread_count: number })[]).map((c) => ({
        cliente: nombre(c),
        mensajes: c.unread_count,
      })),
      citas_de_hoy: citas.error
        ? "agenda no disponible (falta la migración 049)"
        : ((citas.data ?? []) as unknown as (ConNombre & { starts_at: string; kind: string })[]).map((c) => ({
            hora: cuandoLima(c.starts_at),
            tipo: nombreDeCita(c.kind),
            cliente: nombre(c),
          })),
      cuotas_atrasadas_en_la_cuenta: atrasadas.count ?? 0,
      vouchers_por_revisar: vouchers.error ? 0 : vouchers.count ?? 0,
    },
  };
}

async function misClientes(
  ctx: ContextoAsistente,
  args: { filtro?: string; solo_mios?: boolean; de_todo_el_equipo?: boolean },
): Promise<Resultado> {
  // Un asesor ve lo suyo; el dueño y los administradores, todo lo que la
  // base les deja ver. Antes se filtraba siempre por "asignadas a mí", y
  // al dueño —que no tiene ninguna asignada— el asistente le decía que no
  // había nada justo después de haberle listado tres.
  let soloMios = args.solo_mios ?? (args.de_todo_el_equipo === true ? false : !esJefe(ctx.rol));

  const pedir = (mios: boolean) => {
    let q = ctx.db
      .from("conversations")
      .select("id, unread_count, last_message_text, last_message_at, status, assigned_agent_id, contact:contacts(id, name, phone)")
      .eq("account_id", ctx.accountId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(40);
    if (mios) q = q.eq("assigned_agent_id", ctx.userId);
    if (args.filtro === "sin_leer") q = q.gt("unread_count", 0);
    return q;
  };

  let { data, error } = await pedir(soloMios);
  if (error) return { datos: { error: error.message } };

  // Un dueño o un jefe no tiene conversaciones asignadas a su nombre casi
  // nunca: las llevan sus asesores. Filtrar por "las mías" le devolvía
  // cero, y el asistente le contestaba "no tengo clientes visibles"
  // habiéndole listado tres un minuto antes. Si no hay nada suyo y puede
  // ver las del equipo, se le enseñan ésas y se le dice.
  let ampliado = false;
  if (soloMios && !data?.length && esJefe(ctx.rol)) {
    ({ data, error } = await pedir(false));
    if (error) return { datos: { error: error.message } };
    soloMios = false;
    ampliado = true;
  }

  type Fila = {
    id: string;
    unread_count: number;
    last_message_text: string | null;
    last_message_at: string | null;
    status: string;
    assigned_agent_id: string | null;
    contact: { id: string; name: string | null; phone: string | null } | null;
  };
  let filas = (data ?? []) as unknown as Fila[];

  // Quién debe: una sola consulta a la vista de saldos.
  const ids = filas.map((f) => f.contact?.id).filter(Boolean) as string[];
  const deuda = new Map<string, { atrasadas: number; monto: number; moneda: string }>();
  if (ids.length) {
    const { data: saldos } = await ctx.db
      .from("payment_plan_balances")
      .select("contact_id, overdue_count, overdue_amount, currency")
      .in("contact_id", ids);
    for (const s of saldos ?? []) {
      deuda.set(s.contact_id as string, {
        atrasadas: Number(s.overdue_count) || 0,
        monto: Number(s.overdue_amount) || 0,
        moneda: s.currency as string,
      });
    }
  }

  if (args.filtro === "atrasados") filas = filas.filter((f) => (deuda.get(f.contact?.id ?? "")?.atrasadas ?? 0) > 0);

  // Lo que el cliente escribió, con sus palabras. `last_message_text` es
  // sólo la última línea del hilo y muchas veces es la respuesta de la IA,
  // no la del cliente: con eso el asistente concluía "no hay interés" de
  // alguien que había dejado su nombre y pedido información. Una sola
  // consulta para toda la lista.
  const voz = await vozDeLosClientes(ctx, filas.map((f) => f.id));

  if (args.filtro === "sin_responder") {
    filas = filas.filter((f) => voz.get(f.id)?.ultimo === "cliente");
  }

  const quien = soloMios ? new Map<string, string>() : await nombresDelEquipo(ctx);

  return {
    datos: {
      total: filas.length,
      de: soloMios ? "sólo las tuyas" : "todo el equipo",
      ...(ampliado
        ? { aviso: "No tienes ninguna conversación asignada a tu nombre, así que aquí van las de todo el equipo. Dilo así; no digas que no hay clientes." }
        : {}),
      nota: "‘dijo_el_cliente’ son las palabras del propio cliente. No juzgues su interés por ‘ultimo_mensaje’, que puede ser la respuesta de la IA.",
      clientes: filas.slice(0, 25).map((f) => {
        const d = deuda.get(f.contact?.id ?? "");
        const v = voz.get(f.id);
        return {
          cliente: f.contact?.name || f.contact?.phone || "Sin nombre",
          telefono: f.contact?.phone,
          ...(soloMios ? {} : { lleva: quien.get(f.assigned_agent_id ?? "") ?? "sin asignar" }),
          sin_leer: f.unread_count || 0,
          ultimo_mensaje: (f.last_message_text ?? "").slice(0, 90),
          escribio_ultimo: v?.ultimo ?? null,
          dijo_el_cliente: v?.dijo ?? [],
          senales_de_interes: v?.senales ?? [],
          cuando: f.last_message_at ? cuandoLima(f.last_message_at) : null,
          cerrada: f.status === "closed",
          ...(d ? { cuotas_atrasadas: d.atrasadas, monto_atrasado: `${d.moneda} ${d.monto.toFixed(2)}` } : {}),
        };
      }),
    },
  };
}

/**
 * Señales de que alguien va en serio, en las palabras de un cliente
 * peruano escribiendo por WhatsApp. No es un veredicto —eso lo pone el
 * modelo leyendo `dijo_el_cliente`—, es una ayuda para que no se le pase
 * lo evidente: nadie pregunta el precio de un lote por casualidad.
 */
const SENALES: [RegExp, string][] = [
  [/\bprecio|cu[aá]nto (cuesta|est[aá]|sale)|costo|vale\b/i, "pregunta el precio"],
  [/informaci[oó]n|informes|\binfo\b|d[ée]tall|brochure|cat[aá]logo/i, "pide información"],
  [/ubicaci[oó]n|d[oó]nde (queda|est[aá]|es)|direcci[oó]n|c[oó]mo llego|mapa/i, "pregunta la ubicación"],
  [/cuota|financi|inicial|cr[eé]dito|banco|letra|adelanto|pago\b/i, "pregunta por el financiamiento"],
  [/separ|reserv|apart|quiero compr|comprar|adquirir/i, "quiere separar o comprar"],
  [/visit|cita|verlo|conocer|ir a ver|agendar|reuni[oó]n|videollamada/i, "quiere ver el proyecto"],
  [/\bm2\b|metros|[aá]rea|metraje|tama[ñn]o|dimension/i, "pregunta el metraje"],
  [/disponib|quedan|hay lotes|hay casas|hay departamentos|stock/i, "pregunta disponibilidad"],
  [/me interesa|interesad|estoy viendo|me gustar[ií]a/i, "dice que le interesa"],
  [/\bdni\b|mi nombre es|me llamo|mi correo|mi n[uú]mero|mi celular|\b\d{8}\b/i, "dejó sus datos"],
  [/t[ií]tulo|partida|registr|minuta|contrato|documento/i, "pregunta por los papeles"],
];

/**
 * Los últimos mensajes escritos por el cliente en cada conversación, más
 * quién habló al final y qué señales dejó.
 */
async function vozDeLosClientes(
  ctx: ContextoAsistente,
  conversationIds: string[],
): Promise<Map<string, { ultimo: "cliente" | "asesor" | "IA"; dijo: string[]; senales: string[] }>> {
  const mapa = new Map<string, { ultimo: "cliente" | "asesor" | "IA"; dijo: string[]; senales: string[] }>();
  if (!conversationIds.length) return mapa;

  const { data } = await ctx.db
    .from("messages")
    .select("conversation_id, sender_type, content_text, content_type, created_at")
    .in("conversation_id", conversationIds)
    .order("created_at", { ascending: false })
    .limit(600);

  const deQuien = (t: string) => (t === "customer" ? "cliente" : t === "bot" ? "IA" : "asesor");

  for (const m of (data ?? []) as unknown as {
    conversation_id: string;
    sender_type: string;
    content_text: string | null;
    content_type: string | null;
  }[]) {
    let fila = mapa.get(m.conversation_id);
    if (!fila) {
      fila = { ultimo: deQuien(m.sender_type), dijo: [], senales: [] };
      mapa.set(m.conversation_id, fila);
    }
    if (m.sender_type !== "customer" || fila.dijo.length >= 3) continue;
    const texto = (m.content_text ?? "").trim()
      || (m.content_type && m.content_type !== "text" ? `[${m.content_type}]` : "");
    if (!texto) continue;
    fila.dijo.unshift(texto.slice(0, 160)); // del más viejo al más nuevo
    for (const [patron, senal] of SENALES) {
      if (patron.test(texto) && !fila.senales.includes(senal)) fila.senales.push(senal);
    }
  }
  return mapa;
}

async function resumenCliente(ctx: ContextoAsistente, args: { buscar: string }): Promise<Resultado> {
  const { uno, varios } = await buscarContacto(ctx, args.buscar);
  if (!uno) return { datos: candidatos(varios) };

  const [plan, conv, citas, notas, separaciones] = await Promise.all([
    ctx.db
      .from("payment_plans")
      .select("id, currency, total_amount, installments_count, monthly_amount, status, unit:real_estate_units(code, project:real_estate_projects(name))")
      .eq("contact_id", uno.id)
      .in("status", ["activo", "pagado"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    ctx.db
      .from("conversations")
      .select("*")
      .eq("contact_id", uno.id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    ctx.db
      .from("appointments")
      .select("starts_at, kind")
      .eq("contact_id", uno.id)
      .eq("status", "agendada")
      .gte("starts_at", new Date().toISOString())
      .order("starts_at")
      .limit(3),
    ctx.db.from("contact_notes").select("note_text, created_at").eq("contact_id", uno.id).order("created_at", { ascending: false }).limit(5),
    ctx.db.from("reservations").select("status, total_amount, currency, created_at").eq("contact_id", uno.id).order("created_at", { ascending: false }).limit(3),
  ]);

  let saldo: Record<string, unknown> | null = null;
  let proximas: unknown[] = [];
  let vouchers = 0;
  if (plan.data) {
    const [b, p, v] = await Promise.all([
      ctx.db.from("payment_plan_balances").select("*").eq("plan_id", plan.data.id).maybeSingle(),
      ctx.db.from("installments").select("number, amount, due_date").eq("plan_id", plan.data.id).eq("status", "pendiente").order("due_date").limit(3),
      ctx.db.from("installments").select("id", { count: "exact", head: true }).eq("plan_id", plan.data.id).eq("status", "pendiente").not("voucher_path", "is", null),
    ]);
    saldo = b.data;
    proximas = p.data ?? [];
    vouchers = v.error ? 0 : v.count ?? 0;
  }

  let mensajes: { de: string; texto: string; cuando: string }[] = [];
  let atiende: string | null = null;
  if (conv.data) {
    const [{ data: m }, { data: perfil }] = await Promise.all([
      ctx.db
        .from("messages")
        .select("sender_type, content_text, content_type, created_at")
        .eq("conversation_id", conv.data.id)
        .order("created_at", { ascending: false })
        .limit(15),
      conv.data.assigned_agent_id
        ? ctx.db.from("profiles").select("full_name, email").eq("user_id", conv.data.assigned_agent_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    mensajes = (m ?? []).reverse().map((x) => ({
      de: x.sender_type === "customer" ? "cliente" : x.sender_type === "bot" ? "IA" : "equipo",
      texto: ((x.content_text as string) || `[${x.content_type}]`).slice(0, 240),
      cuando: cuandoLima(x.created_at as string),
    }));
    atiende = perfil ? (perfil.full_name as string) || (perfil.email as string) : null;
  }

  const unidad = plan.data?.unit as unknown as { code: string | null; project: { name: string } | null } | null;
  return {
    datos: {
      cliente: { nombre: uno.name, telefono: uno.phone, dni: uno.dni ?? null, correo: uno.email ?? null, origen: uno.lead_source ?? null },
      lo_atiende: atiende,
      canal: conv.data?.channel ?? "whatsapp",
      compro: plan.data
        ? {
            inmueble: [unidad?.code, unidad?.project?.name].filter(Boolean).join(" · ") || null,
            moneda: plan.data.currency,
            total: plan.data.total_amount,
            cuota_mensual: plan.data.monthly_amount,
            cuotas: plan.data.installments_count,
            estado: plan.data.status,
            pagadas: saldo?.paid_count ?? null,
            por_cobrar: saldo?.pending_amount ?? null,
            cuotas_atrasadas: saldo?.overdue_count ?? 0,
            monto_atrasado: saldo?.overdue_amount ?? 0,
            proximas_cuotas: proximas,
            vouchers_por_revisar: vouchers,
          }
        : "todavía no compró (interesado)",
      citas: citas.error ? [] : (citas.data ?? []).map((c) => ({ cuando: cuandoLima(c.starts_at as string), tipo: nombreDeCita(c.kind as string) })),
      separaciones: separaciones.data ?? [],
      notas: (notas.data ?? []).map((n) => n.note_text),
      ultimos_mensajes: mensajes,
    },
  };
}

async function miAgenda(
  ctx: ContextoAsistente,
  args: { desde?: string; hasta?: string; de_todo_el_equipo?: boolean },
): Promise<Resultado> {
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(args.desde ?? "") ? args.desde! : hoyLima();
  const hasta = /^\d{4}-\d{2}-\d{2}$/.test(args.hasta ?? "")
    ? args.hasta!
    : new Intl.DateTimeFormat("en-CA", { timeZone: LIMA }).format(new Date(Date.now() + 7 * 864e5));

  // Un jefe que pregunta "¿qué citas hay esta semana?" quiere las del
  // equipo, no las suyas —que suelen ser ninguna—. Sigue mandando RLS:
  // sólo salen las que esa persona ya podía ver.
  const delEquipo = args.de_todo_el_equipo === true && esJefe(ctx.rol);

  let q = ctx.db
    .from("appointments")
    .select("starts_at, minutes, kind, notes, user_id, contact:contacts(name, phone)")
    .eq("account_id", ctx.accountId)
    .eq("status", "agendada")
    .gte("starts_at", new Date(`${desde}T00:00:00-05:00`).toISOString())
    .lte("starts_at", new Date(`${hasta}T23:59:59-05:00`).toISOString())
    .order("starts_at");
  if (!delEquipo) q = q.eq("user_id", ctx.userId);

  const { data, error } = await q;
  if (error) return { datos: { error: "La agenda no está disponible: falta correr la migración 049." } };

  const quien = delEquipo ? await nombresDelEquipo(ctx) : new Map<string, string>();

  return {
    datos: {
      desde,
      hasta,
      de: delEquipo ? "todo el equipo" : "sólo tuyas",
      citas: (data ?? []).map((c) => {
        const contacto = c.contact as unknown as { name: string | null; phone: string | null } | null;
        return {
          cuando: cuandoLima(c.starts_at as string),
          minutos: c.minutes,
          tipo: nombreDeCita(c.kind as string),
          cliente: contacto?.name || contacto?.phone || "Cliente",
          ...(delEquipo ? { atiende: quien.get(c.user_id as string) ?? "?" } : {}),
          notas: c.notes,
        };
      }),
    },
  };
}

/** user_id → nombre, para no repetir la consulta en cada fila. */
async function nombresDelEquipo(ctx: ContextoAsistente): Promise<Map<string, string>> {
  const { data } = await ctx.db
    .from("profiles")
    .select("user_id, full_name, email")
    .eq("account_id", ctx.accountId);
  return new Map(
    (data ?? []).map((p) => [p.user_id as string, (p.full_name as string) || (p.email as string) || "?"]),
  );
}

/**
 * Qué vende Golden. Sale de la app —lo mismo que ve el cliente— y no de
 * una lista pegada a mano, así que el asesor y el cliente nunca oyen dos
 * precios distintos.
 */
async function catalogo(ctx: ContextoAsistente, args: { buscar?: string }): Promise<Resultado> {
  const datos = await catalogoDeGolden();
  if (!datos) {
    return {
      datos: {
        error:
          "No se pudo leer el catálogo de la app. Falta configurar GOLDEN_APP_URL en el CRM, o la app no respondió.",
      },
    };
  }

  const buscado = (args.buscar ?? "").trim().toLowerCase();
  const porTipo: Record<string, string[]> = {
    casa: ["casa"],
    casas: ["casa"],
    lote: ["lotes"],
    lotes: ["lotes"],
    terreno: ["lotes"],
    terrenos: ["lotes"],
    departamento: ["residencial"],
    departamentos: ["residencial"],
    depa: ["residencial"],
    depas: ["residencial"],
  };

  let proyectos = datos.proyectos;
  if (buscado) {
    const tipos = porTipo[buscado];
    proyectos = tipos
      ? proyectos.filter((p) => tipos.includes(p.categoria ?? ""))
      : proyectos.filter((p) =>
          `${p.nombre} ${p.nombreCorto ?? ""} ${p.donde.ciudad ?? ""} ${p.donde.distrito ?? ""}`
            .toLowerCase()
            .includes(buscado),
        );
    // Una búsqueda que no encuentra nada no puede dejar al modelo sin
    // datos: es cuando empieza a inventar.
    if (!proyectos.length) proyectos = datos.proyectos;
  }

  return {
    datos: {
      leido_de: "la Golden App",
      proyectos: proyectos.map((p) => {
        const c = p.comercial;
        const libres = p.lotes?.filter((l) => l.estado === "libre") ?? null;
        return {
          proyecto: p.nombre,
          tipo: p.categoria === "residencial" ? "departamentos" : p.categoria,
          estado: p.estado === "ACTIVE" ? "en venta" : p.estado === "SOLD_OUT" ? "vendido" : p.estado,
          donde: [p.donde.direccion, p.donde.ciudad].filter(Boolean).join(", "),
          precio_desde: c.precioDesde ? `${c.moneda === "PEN" ? "S/" : c.moneda} ${c.precioDesde.toLocaleString("es-PE")}` : null,
          area: c.rangoAreas,
          dormitorios: c.dormitorios,
          financiamiento: c.financiamiento,
          inicial_desde: c.inicialDesde,
          cuota_desde: c.cuotaDesde,
          plazo_meses: c.plazoMeses,
          ...(libres
            ? {
                lotes_libres: libres.length,
                lotes_totales: p.lotes!.length,
                tamanos_libres: [...new Set(libres.map((l) => Math.round(l.area ?? 0)).filter(Boolean))].sort((a, b) => a - b),
              }
            : {}),
          ...(p.unidades
            ? {
                unidades_en_venta: p.unidades
                  .filter((u) => u.disponible)
                  .map((u) => `${u.nombre}: ${u.area} m²${u.precio ? `, S/ ${u.precio.toLocaleString("es-PE")}` : ""}`),
              }
            : {}),
          por_que_gusta: p.puntosVenta.slice(0, 5),
        };
      }),
    },
  };
}

/** Cómo está repartido el trabajo: quién es quién y cuánto lleva cada uno. */
async function equipo(ctx: ContextoAsistente): Promise<Resultado> {
  const { data: gente, error } = await ctx.db
    .from("profiles")
    .select("user_id, full_name, email, account_role, area")
    .eq("account_id", ctx.accountId);
  if (error) return { datos: { error: "No se pudo leer el equipo." } };

  const [{ data: convs }, { data: horarios }] = await Promise.all([
    ctx.db.from("conversations").select("assigned_agent_id").eq("account_id", ctx.accountId),
    ctx.db.from("staff_availability").select("user_id").eq("account_id", ctx.accountId),
  ]);

  const carga = new Map<string, number>();
  for (const c of convs ?? []) {
    const id = c.assigned_agent_id as string | null;
    if (id) carga.set(id, (carga.get(id) ?? 0) + 1);
  }
  const conHorario = new Set((horarios ?? []).map((h) => h.user_id as string));

  const ROL: Record<string, string> = {
    owner: "dueño",
    admin: "administrador",
    agent: "asesor",
    viewer: "solo lectura",
  };

  return {
    datos: {
      miembros: (gente ?? []).map((p) => ({
        nombre: (p.full_name as string) || (p.email as string) || "?",
        rol: ROL[p.account_role as string] ?? p.account_role,
        area: p.area ?? "sin área",
        conversaciones: carga.get(p.user_id as string) ?? 0,
        // Sin horarios publicados no se le puede agendar nada, y es la
        // causa más común de "la IA no ofrece horas".
        tiene_horarios: conHorario.has(p.user_id as string),
      })),
      nota: "Quien no tiene horarios publicados no aparece cuando alguien quiere agendar una cita.",
    },
  };
}

async function horasLibres(ctx: ContextoAsistente, args: { dias?: number }): Promise<Resultado> {
  const dias = Math.min(Math.max(Number(args.dias) || 7, 1), 14);
  try {
    const libres = await diasLibres(ctx.db, ctx.accountId, [ctx.userId], dias, 30);
    if (!libres.length) {
      return { datos: { sin_horarios: true, consejo: "No tiene horarios publicados o están llenos. Se ponen en la app: Agenda → Mis horarios." } };
    }
    return {
      datos: {
        dias: libres.slice(0, 6).map((d) => ({ dia: d.etiqueta, fecha: d.fecha, horas: d.tramos.map((t) => t.hora) })),
      },
    };
  } catch {
    return { datos: { error: "La agenda no está disponible: falta correr la migración 049." } };
  }
}

async function agendarCita(
  ctx: ContextoAsistente,
  args: { cliente: string; inicio: string; tipo: string; minutos?: number; notas?: string },
): Promise<Resultado> {
  const cuando = Date.parse(args.inicio);
  if (Number.isNaN(cuando)) return { datos: { error: "La fecha y hora no se entendieron." } };
  if (cuando < Date.now() - 5 * 60_000) return { datos: { error: "Esa hora ya pasó." } };

  const { uno, varios } = await buscarContacto(ctx, args.cliente);
  if (!uno) return { datos: candidatos(varios) };

  const tipo = ["videollamada", "visita", "llamada"].includes(args.tipo) ? args.tipo : "videollamada";
  const sala = `golden-${uno.id.replace(/-/g, "").slice(0, 18)}`;
  const { data, error } = await ctx.db
    .from("appointments")
    .insert({
      account_id: ctx.accountId,
      contact_id: uno.id,
      user_id: ctx.userId,
      starts_at: new Date(cuando).toISOString(),
      minutes: Math.min(Math.max(Number(args.minutos) || 30, 10), 240),
      kind: tipo,
      room: tipo === "videollamada" ? sala : null,
      notes: args.notas?.slice(0, 500) || null,
      created_by: "equipo",
    })
    .select("id, starts_at")
    .single();

  if (error) {
    const choque = (error as { code?: string }).code === "23505";
    return {
      datos: {
        error: choque
          ? "Ya tienes otra cita a esa hora."
          : /schema cache|does not exist/i.test(error.message)
            ? "La agenda no está disponible: falta correr la migración 049."
            : `No se pudo agendar: ${error.message}`,
      },
    };
  }

  const texto = `${nombreDeCita(tipo)} el ${cuandoLima(data.starts_at as string)}`;
  // Que le suene al cliente si tiene la app; si no, no pasa nada.
  await notifyClient(supabaseAdmin(), {
    contactId: uno.id,
    title: "Golden Habitat",
    body: `Tienes una ${texto}. La ves en la pestaña Citas.`,
  }).catch(() => {});

  return {
    datos: { ok: true, cliente: uno.name || uno.phone, cita: texto },
    accion: { tipo: "cita_agendada", detalle: `${uno.name || uno.phone}: ${texto}` },
  };
}

async function cuotasAtrasadas(ctx: ContextoAsistente): Promise<Resultado> {
  const { data, error } = await ctx.db
    .from("installments")
    .select("number, amount, due_date, plan:payment_plans(currency, contact:contacts(name, phone))")
    .eq("account_id", ctx.accountId)
    .eq("status", "pendiente")
    .lt("due_date", hoyLima())
    .order("due_date")
    .limit(30);
  if (error) return { datos: { error: error.message } };
  return {
    datos: {
      total: (data ?? []).length,
      cuotas: (data ?? []).map((c) => {
        const plan = c.plan as unknown as { currency: string; contact: { name: string | null; phone: string | null } | null } | null;
        return {
          cliente: plan?.contact?.name || plan?.contact?.phone || "Cliente",
          cuota: c.number,
          monto: `${plan?.currency ?? ""} ${Number(c.amount).toFixed(2)}`,
          vencio: c.due_date,
        };
      }),
    },
  };
}

async function agregarNota(ctx: ContextoAsistente, args: { cliente: string; texto: string }): Promise<Resultado> {
  const texto = (args.texto ?? "").trim().slice(0, 2000);
  if (!texto) return { datos: { error: "La nota está vacía." } };
  const { uno, varios } = await buscarContacto(ctx, args.cliente);
  if (!uno) return { datos: candidatos(varios) };
  const { error } = await ctx.db.from("contact_notes").insert({
    contact_id: uno.id,
    user_id: ctx.userId,
    account_id: ctx.accountId,
    note_text: texto,
  });
  if (error) return { datos: { error: `No se pudo guardar: ${error.message}` } };
  return {
    datos: { ok: true, cliente: uno.name || uno.phone },
    accion: { tipo: "nota_guardada", detalle: `Nota en la ficha de ${uno.name || uno.phone}` },
  };
}

/** Ejecuta una herramienta por nombre. Nunca lanza: devuelve el error como dato. */
export async function ejecutarHerramienta(
  ctx: ContextoAsistente,
  nombre: string,
  argumentos: string,
): Promise<Resultado> {
  let args: Record<string, unknown> = {};
  try {
    args = argumentos ? JSON.parse(argumentos) : {};
  } catch {
    return { datos: { error: "Argumentos inválidos." } };
  }
  try {
    switch (nombre) {
      case "resumen_del_dia":
        return await resumenDelDia(ctx);
      case "mis_clientes":
        return await misClientes(ctx, args as { filtro?: string; de_todo_el_equipo?: boolean });
      case "resumen_cliente":
        return await resumenCliente(ctx, args as { buscar: string });
      case "catalogo":
        return await catalogo(ctx, args as { buscar?: string });
      case "equipo":
        return await equipo(ctx);
      case "mi_agenda":
        return await miAgenda(ctx, args as { desde?: string; hasta?: string; de_todo_el_equipo?: boolean });
      case "horas_libres":
        return await horasLibres(ctx, args as { dias?: number });
      case "agendar_cita":
        return await agendarCita(ctx, args as { cliente: string; inicio: string; tipo: string; minutos?: number; notas?: string });
      case "cuotas_atrasadas":
        return await cuotasAtrasadas(ctx);
      case "agregar_nota":
        return await agregarNota(ctx, args as { cliente: string; texto: string });
      default:
        return { datos: { error: `Herramienta desconocida: ${nombre}` } };
    }
  } catch (err) {
    console.error(`[assistant] tool ${nombre} failed:`, err);
    return { datos: { error: "Algo falló al consultar el CRM." } };
  }
}
