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
import { catalogoDeGolden, esCuentaDeGolden } from "@/lib/golden/catalogo";
import { buscarLotes, dinero, simularCuotas, type ArgsBuscarLote, type ArgsSimular } from "./lotes";
import { elegirCitaACorregir, fechaLima, nombreCoincide, pedidoDeCambioDeCita, sumarSaldos, type FilaSaldo } from "./coincidencias";
import { claveDeEtapa, cuentaConEtapas, moverEtapa, NOMBRE_DE_ETAPA, type ClaveDeEtapa } from "@/lib/etapas/mover";
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
  tipo: "cita_agendada" | "nota_guardada" | "cita_cambiada" | "etapa_movida";
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
        "QUÉ VENDE LA EMPRESA: los proyectos que hay en la app —casas, lotes y departamentos— con su precio, su ubicación, su financiamiento, cuántos lotes quedan libres de cada tamaño y qué unidades siguen en venta. Úsala SIEMPRE que pregunten por precios, por lo que se ofrece, por qué hay disponible o por qué mandarle a un cliente. No tiene nada que ver con los clientes asignados: contesta aunque la persona no tenga ninguno.",
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
      name: "resumen_de_conversacion",
      description:
        "LEE EL CHAT ENTERO de un contacto y devuelve todo lo que hace falta para saber qué decirle: qué pidió con sus palabras, en qué punto quedó, quién habló al final, cuánto lleva callado, sus señales de interés y si tiene cita o deuda. Úsala cuando pidan el resumen de una conversación, qué contestarle a alguien o cómo seguir con un cliente.",
      parameters: {
        type: "object",
        properties: {
          cliente: { type: "string", description: "Nombre, teléfono o DNI." },
        },
        required: ["cliente"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buscar_lote",
      description:
        "Lotes concretos de los planos, con su estado EN VIVO (libre, solicitado, separado, vendido) y su PRECIO EXACTO (lista/financiado, al contado y promoción). Úsala para '¿está libre el A-12?', '¿cuánto cuesta el lote B-3?', '¿qué te queda de 200 m²?', '¿cuántos separados hay en Colinas II?'. Devuelve el recuento por estado.",
      parameters: {
        type: "object",
        properties: {
          proyecto: { type: "string", description: "Nombre del proyecto, p. ej. 'Colinas II' o 'Colinas 2'. Vacío = todos." },
          manzana: { type: "string", description: "Letra de la manzana, p. ej. 'K'." },
          area_minima: { type: "number", description: "Metros cuadrados mínimos." },
          area_maxima: { type: "number", description: "Metros cuadrados máximos." },
          lote: { type: "string", description: "Código del lote como lo digan: 'A-12', 'A12', 'Mz A lote 12'." },
          estado: {
            type: "string",
            enum: ["libre", "solicitado", "separado", "vendido", "todos"],
            description: "Qué lotes listar. Sin esto lista los libres (o el lote pedido, esté como esté).",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "simular_cuotas",
      description:
        "CALCULA cuotas: nunca hagas tú la cuenta. Lote: (precio financiado del lote − inicial) / meses, sin intereses, con la inicial y el plazo del proyecto si no los dicen, y también la cuota con precio de promoción si la hay. Casa o departamento: crédito con cuota fija y la TEA que diga el asesor (si no la dice, la herramienta la pide). Úsala para '¿cuánto pagaría al mes por el A-12?', 'simúlame con S/ 5,000 de inicial a 36 meses'.",
      parameters: {
        type: "object",
        properties: {
          proyecto: { type: "string", description: "Proyecto, si hace falta para ubicar el lote o para una casa/depa." },
          lote: { type: "string", description: "Código del lote ('A-12', 'Mz A lote 12')." },
          precio: { type: "number", description: "Solo si el asesor da otro precio." },
          inicial: { type: "number", description: "Monto de la inicial, si lo dicen." },
          inicial_porcentaje: { type: "number", description: "Inicial en %, para casa/depa." },
          meses: { type: "number", description: "Número de cuotas, si lo dicen." },
          tea: { type: "number", description: "TEA en % (solo casa/depa), la que diga el asesor." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "quien_no_contesta",
      description:
        "Los clientes que escribieron, se les respondió y llevan horas o días sin volver. Ordenados por cuánto llevan callados, con lo último que dijeron y cuánto queda antes de que se cierre la ventana de 24 h de WhatsApp. Para saber a quién rescatar hoy.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "embudo",
      description:
        "Cómo va el negocio en números: cuántos contactos escribieron, cuántos siguen en conversación, cuántos tienen cita, cuántos compraron y cuánto se está cobrando. Acepta un periodo en días.",
      parameters: {
        type: "object",
        properties: {
          dias: { type: "integer", minimum: 1, maximum: 365, description: "Cuántos días hacia atrás (por defecto 30)." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rendimiento_del_equipo",
      description:
        "Cuánto lleva y cómo va cada asesor: conversaciones, sin responder, citas agendadas y clientes con plan de pago. Sólo para dueño o administrador.",
      parameters: {
        type: "object",
        properties: {
          dias: { type: "integer", minimum: 1, maximum: 365, description: "Periodo de las citas, por defecto 30 días." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "poner_quien_responde",
      description:
        "Cambia quién lleva una conversación: la IA o la persona que pregunta. Tomarla calla a la IA en ese chat; devolverla hace que la IA siga. Llámala sólo si te lo piden claramente.",
      parameters: {
        type: "object",
        properties: {
          cliente: { type: "string", description: "Nombre, teléfono o DNI." },
          quien: { type: "string", enum: ["ia", "yo"], description: "'yo' = la tomo yo; 'ia' = que siga la asistente." },
        },
        required: ["cliente", "quien"],
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
        "Agenda una cita de quien pregunta con un cliente. El cliente puede no estar en el CRM (viene de otro lado, un referido, un conocido): igual se agenda y queda registrado. Llámala SOLO cuando el cliente, el día, la hora y el tipo estén claros y la persona lo haya pedido o confirmado.",
      parameters: {
        type: "object",
        properties: {
          cliente: { type: "string", description: "Nombre, teléfono o DNI del cliente. Si no está en el CRM, su nombre." },
          telefono: {
            type: "string",
            description: "Teléfono del cliente, si lo dieron. Sirve para encontrarlo y, si es nuevo, para registrarlo con él.",
          },
          cliente_nuevo: {
            type: "boolean",
            description:
              "true = no es ninguno de los que ya están en el CRM: se registra con este nombre y teléfono. Úsalo cuando la búsqueda devolvió candidatos y la persona dijo que no es ninguno, o cuando ya dijo que es alguien de fuera.",
          },
          enlace: {
            type: "string",
            description: "Enlace de Zoom, Meet u otra sala, si la persona ya tiene uno. Sin enlace, la videollamada usa la sala propia.",
          },
          inicio: {
            type: "string",
            description: "Fecha y hora de inicio en ISO 8601 con zona de Lima, p. ej. 2026-09-21T10:30:00-05:00.",
          },
          tipo: {
            type: "string",
            enum: ["videollamada", "visita", "llamada"],
            description: "visita = presencial en la oficina; videollamada = Zoom, Meet o la sala propia; llamada = por teléfono.",
          },
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
      name: "cambiar_cita",
      description:
        "Corrige una cita que ya está en la agenda: la cambia de hora, la marca como cumplida (el cliente vino o se hizo la llamada) o la cancela. Toma la próxima cita pendiente de ese cliente. Úsala cuando digan 'cámbiale la cita a Karina para las 5', 'Jhonson ya vino', 'cancela la visita de Elsa'.",
      parameters: {
        type: "object",
        properties: {
          cliente: { type: "string", description: "Nombre, teléfono o DNI del cliente de la cita." },
          nuevo_inicio: {
            type: "string",
            description: "Nueva fecha y hora en ISO 8601 con zona de Lima (2026-11-23T17:00:00-05:00). Solo para cambiar la hora.",
          },
          estado: { type: "string", enum: ["cumplida", "cancelada"], description: "Solo si vino o se canceló." },
        },
        required: ["cliente"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mover_etapa",
      description:
        "Cambia la etapa de un cliente en el embudo: nuevo, contestó, en seguimiento, agendó visita, visitó, separó/compró o perdido. Úsala cuando la persona lo pida o lo cuente ('Karina ya separó', 'Ronald no le interesa', 'pásalo a seguimiento'). Contestó, agendó y visitó se marcan solos con los mensajes y las citas; esto es para corregir o para lo que solo sabe el equipo.",
      parameters: {
        type: "object",
        properties: {
          cliente: { type: "string", description: "Nombre, teléfono o DNI." },
          etapa: { type: "string", description: "La etapa como la diga la persona: 'separó', 'compró', 'perdido', 'seguimiento', 'visitó'…" },
        },
        required: ["cliente", "etapa"],
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

const SIN_ACCESO_COBRANZAS = "Sin acceso a cobranzas: esa información es del área de Cobranzas, Contabilidad y Gerencia.";

/**
 * ¿Esta persona NO tiene acceso a cobranzas? (my_module_access, migración 084).
 * Solo es true cuando la base lo dice; sin la 084 (o ante cualquier error)
 * es false y el asistente responde como antes.
 */
async function sinAccesoCobranzas(ctx: ContextoAsistente): Promise<boolean> {
  try {
    const { data, error } = await ctx.db.rpc("my_module_access");
    if (error || !data || typeof data !== "object") return false;
    return (data as Record<string, unknown>).cobranzas === false;
  } catch {
    return false;
  }
}

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
  // Un solo resultado vale si se buscó por teléfono/DNI o si el nombre
  // coincide de verdad: "Ana" no puede ser "Mariana" sin preguntar.
  if (lista.length === 1 && (digitos.length >= 6 || nombreCoincide(lista[0].name, q))) return { uno: lista[0] };
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

  const sinCobranzas = await sinAccesoCobranzas(ctx);
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
      cuotas_atrasadas_en_la_cuenta: sinCobranzas ? SIN_ACCESO_COBRANZAS : atrasadas.count ?? 0,
      vouchers_por_revisar: sinCobranzas ? SIN_ACCESO_COBRANZAS : vouchers.error ? 0 : vouchers.count ?? 0,
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
  const deuda = new Map<string, ReturnType<typeof sumarSaldos>>();
  const sinCobranzas = await sinAccesoCobranzas(ctx);
  if (sinCobranzas && args.filtro === "atrasados") {
    return { datos: { error: SIN_ACCESO_COBRANZAS } };
  }
  if (ids.length && !sinCobranzas) {
    const { data: saldos } = await ctx.db
      .from("payment_plan_balances")
      .select("contact_id, overdue_count, overdue_amount, pending_amount, next_due_date, currency")
      .in("contact_id", ids);
    // Un cliente con dos lotes tiene dos planes: se suman, por moneda.
    const porContacto = new Map<string, FilaSaldo[]>();
    for (const s of (saldos ?? []) as (FilaSaldo & { contact_id: string })[]) {
      porContacto.set(s.contact_id, [...(porContacto.get(s.contact_id) ?? []), s]);
    }
    for (const [id, filas] of porContacto) deuda.set(id, sumarSaldos(filas));
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
          ...(sinCobranzas ? { cobranza: SIN_ACCESO_COBRANZAS } : {}),
          ...(d
            ? {
                cuotas_atrasadas: d.atrasadas,
                monto_atrasado: d.por_moneda.filter((m) => m.atrasado > 0).map((m) => dinero(m.atrasado, m.moneda)).join(" + ") || null,
              }
            : {}),
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
  const sinCobranzas = await sinAccesoCobranzas(ctx);
  if (plan.data && !sinCobranzas) {
    const [b, p, v] = await Promise.all([
      ctx.db.from("payment_plan_balances").select("*").eq("plan_id", plan.data.id).maybeSingle(),
      ctx.db.from("installments").select("id, number, amount, due_date").eq("plan_id", plan.data.id).eq("status", "pendiente").order("due_date").limit(3),
      ctx.db.from("installments").select("id", { count: "exact", head: true }).eq("plan_id", plan.data.id).eq("status", "pendiente").not("voucher_path", "is", null),
    ]);
    saldo = b.data;
    // Saldo real de cada próxima cuota (084): lo que falta, no el monto original.
    const filasProximas = (p.data ?? []) as { id: string; number: number; amount: number | string; due_date: string }[];
    const { data: faltan, error: errFaltan } = filasProximas.length
      ? await ctx.db
          .from("installment_balances")
          .select("installment_id, remaining")
          .in("installment_id", filasProximas.map((c) => c.id))
      : { data: [], error: null };
    const restante = new Map<string, number>(
      errFaltan ? [] : (faltan ?? []).map((x) => [x.installment_id as string, Number(x.remaining)] as [string, number]),
    );
    proximas = filasProximas.map((c) => ({
      number: c.number,
      amount: restante.get(c.id) ?? c.amount,
      due_date: c.due_date,
    }));
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
      // Sin acceso (084) el plan ni siquiera es visible por RLS: se dice
      // "sin acceso", nunca "todavía no compró".
      compro: sinCobranzas
        ? { cobranza: SIN_ACCESO_COBRANZAS }
        : plan.data
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
 * El nombre con el que se presenta la cuenta: Golden Habitat, Broker
 * Home... Sale de `accounts.brand_name` (o del nombre de la cuenta).
 */
export async function marcaDeLaCuenta(accountId: string): Promise<string> {
  if (esCuentaDeGolden(accountId)) return "Golden Habitat";
  const { data } = await supabaseAdmin()
    .from("accounts")
    .select("name, brand_name")
    .eq("id", accountId)
    .maybeSingle();
  return ((data?.brand_name as string | null) ?? "").trim() || ((data?.name as string | null) ?? "").trim() || "la empresa";
}

/**
 * Lo que vende una cuenta que no es Golden: la información del negocio que
 * se cargó para su IA de WhatsApp. Así el equipo y el cliente oyen lo mismo.
 */
async function catalogoDeLaCuenta(accountId: string): Promise<Resultado> {
  const { data } = await supabaseAdmin()
    .from("ai_configs")
    .select("system_prompt")
    .eq("account_id", accountId)
    .maybeSingle();
  const informacion = ((data?.system_prompt as string | null) ?? "").trim();
  if (!informacion) {
    return {
      datos: {
        error:
          "Esta cuenta todavía no tiene cargada la información de lo que vende. Se carga en el contexto de la IA de WhatsApp.",
      },
    };
  }
  return {
    datos: {
      leido_de: "la información del negocio que usa la IA de WhatsApp (lo mismo que oye el cliente)",
      informacion,
    },
  };
}

/**
 * Qué vende Golden. Sale de la app —lo mismo que ve el cliente— y no de
 * una lista pegada a mano, así que el asesor y el cliente nunca oyen dos
 * precios distintos. Las demás cuentas usan su propia información.
 */
async function catalogo(ctx: ContextoAsistente, args: { buscar?: string }): Promise<Resultado> {
  if (!esCuentaDeGolden(ctx.accountId)) return catalogoDeLaCuenta(ctx.accountId);
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
  let noEncontrado = false;
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
    // datos: es cuando empieza a inventar. Pero se le dice, para que no
    // atribuya a "Villa X" los datos de otro proyecto.
    if (!proyectos.length) {
      proyectos = datos.proyectos;
      noEncontrado = true;
    }
  }

  return {
    datos: {
      leido_de: "la Golden App",
      ...(noEncontrado
        ? { aviso: `No hay ningún proyecto que se llame "${args.buscar}". Abajo están TODOS: dilo así, no le atribuyas estos datos.` }
        : {}),
      nota: "precio_desde es del proyecto, no de un lote: para el precio de un lote usa buscar_lote, y para cuotas simular_cuotas.",
      proyectos: proyectos.map((p) => {
        const c = p.comercial;
        const libres = p.lotes?.filter((l) => l.estado === "libre") ?? null;
        return {
          proyecto: p.nombre,
          tipo: p.categoria === "residencial" ? "departamentos" : p.categoria,
          estado: p.estado === "ACTIVE" ? "en venta" : p.estado === "SOLD_OUT" ? "vendido" : p.estado,
          donde: [p.donde.direccion, p.donde.ciudad].filter(Boolean).join(", "),
          precio_desde: c.precioDesde ? dinero(c.precioDesde, c.moneda) : null,
          area: c.rangoAreas,
          dormitorios: c.dormitorios,
          financiamiento: c.financiamiento,
          inicial_desde: c.inicialDesde != null ? dinero(c.inicialDesde, c.moneda) : null,
          cuota_desde: c.cuotaDesde != null ? dinero(c.cuotaDesde, c.moneda) : null,
          plazo_meses: c.plazoMeses,
          ...(libres && p.lotes!.every((l) => l.estado === "sin_confirmar")
            ? { lotes_libres: null, aviso_lotes: "No se pudo leer la disponibilidad ahora: no digas cuántos quedan." }
            : libres
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
                  .map((u) => `${u.nombre}: ${u.area} m²${u.precio ? `, ${dinero(u.precio, c.moneda)}` : ""}`),
              }
            : {}),
          por_que_gusta: p.puntosVenta.slice(0, 5),
        };
      }),
    },
  };
}

/**
 * El chat entero de alguien, masticado para poder decidir qué contestarle.
 *
 * `resumen_cliente` da su ficha; esto da la CONVERSACIÓN: lo que pidió con
 * sus palabras, quién habló al final, cuánto lleva callado y cuánto queda
 * de la ventana de 24 h. Es lo que hacía falta para que el asistente
 * pudiera proponer una respuesta en vez de describir al cliente.
 */
async function resumenDeConversacion(ctx: ContextoAsistente, args: { cliente: string }): Promise<Resultado> {
  const { uno, varios } = await buscarContacto(ctx, args.cliente);
  if (!uno) return { datos: candidatos(varios) };

  const { data: conv } = await ctx.db
    .from("conversations")
    .select("id, channel, unread_count, assigned_agent_id, ai_autoreply_disabled, followup_count")
    .eq("contact_id", uno.id)
    .eq("account_id", ctx.accountId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conv) return { datos: { cliente: uno.name || uno.phone, sin_conversacion: true } };

  const { data: msjs } = await ctx.db
    .from("messages")
    .select("sender_type, content_text, content_type, created_at")
    .eq("conversation_id", conv.id)
    .order("created_at", { ascending: false })
    .limit(40);

  const mensajes = (msjs ?? []).slice().reverse();
  const delCliente = mensajes.filter((m) => m.sender_type === "customer");
  const ultimo = mensajes[mensajes.length - 1];
  const ultimoDelCliente = delCliente[delCliente.length - 1];

  const senales: string[] = [];
  for (const m of delCliente) {
    for (const [patron, senal] of SENALES) {
      if (patron.test((m.content_text as string) ?? "") && !senales.includes(senal)) senales.push(senal);
    }
  }

  const desde = ultimoDelCliente ? Date.parse(ultimoDelCliente.created_at as string) : null;
  const calladoMin = desde ? Math.round((Date.now() - desde) / 60_000) : null;
  const ventanaMin = desde ? Math.round(24 * 60 - (Date.now() - desde) / 60_000) : null;

  const sinCobranzas = await sinAccesoCobranzas(ctx);
  const [{ data: planes }, { data: citas }] = await Promise.all([
    sinCobranzas
      ? Promise.resolve({ data: null })
      : ctx.db
          .from("payment_plan_balances")
          .select("currency, pending_amount, overdue_count, next_due_date")
          .eq("contact_id", uno.id),
    ctx.db
      .from("appointments")
      .select("starts_at, kind, status")
      .eq("contact_id", uno.id)
      .eq("status", "agendada")
      .gte("starts_at", new Date().toISOString())
      .order("starts_at")
      .limit(2),
  ]);

  // Dos lotes = dos planes: antes .maybeSingle() fallaba y el cliente salía sin deuda.
  const saldo = planes?.length ? sumarSaldos(planes as FilaSaldo[]) : null;
  const quien = conv.assigned_agent_id ? await nombresDelEquipo(ctx) : new Map<string, string>();

  return {
    datos: {
      cliente: uno.name || uno.phone,
      telefono: uno.phone,
      llego_por: uno.lead_source ?? null,
      canal: conv.channel ?? "whatsapp",
      lleva: quien.get((conv.assigned_agent_id as string) ?? "") ?? "sin asignar",
      responde_ahora: conv.ai_autoreply_disabled ? "un asesor" : "la asistente virtual",
      veces_que_se_le_insistio: conv.followup_count ?? 0,
      escribio_ultimo:
        ultimo?.sender_type === "customer" ? "el cliente" : ultimo?.sender_type === "bot" ? "la IA" : "el equipo",
      minutos_callado: calladoMin,
      // Cuánto queda para no poder escribirle libremente. En negativo, ya
      // pasó: sólo se le puede mandar una plantilla.
      minutos_de_ventana_restantes: ventanaMin,
      senales_de_interes: senales,
      ...(sinCobranzas ? { cobranza: SIN_ACCESO_COBRANZAS } : { ya_es_cliente: Boolean(saldo) }),
      ...(saldo
        ? {
            planes: saldo.planes,
            por_pagar: saldo.por_moneda.map((m) => dinero(m.pendiente, m.moneda)).join(" + "),
            cuotas_atrasadas: saldo.atrasadas,
            proxima_cuota: saldo.proximo_vencimiento,
          }
        : {}),
      citas: (citas ?? []).map((c) => `${nombreDeCita(c.kind as string)} el ${cuandoLima(c.starts_at as string)}`),
      conversacion: mensajes.map((m) => ({
        de: m.sender_type === "customer" ? "cliente" : m.sender_type === "bot" ? "IA" : "equipo",
        texto: ((m.content_text as string) || `[${m.content_type}]`).slice(0, 300),
        cuando: cuandoLima(m.created_at as string),
      })),
    },
  };
}

/** Lotes concretos del plano: por proyecto, manzana, metraje o código. */
async function buscarLote(
  ctx: ContextoAsistente,
  args: ArgsBuscarLote,
): Promise<Resultado> {
  if (!esCuentaDeGolden(ctx.accountId)) {
    return {
      datos: {
        error:
          "Esta cuenta no tiene planos de lotes cargados en la app, así que no se puede ver lote por lote. Usa `catalogo` para la información del proyecto y, para un lote concreto, que lo confirme el asesor.",
      },
    };
  }
  const datos = await catalogoDeGolden();
  if (!datos) return { datos: { error: "No se pudo leer el catálogo de la app." } };
  const r = buscarLotes(datos, args);
  return {
    datos: {
      ...r,
      ...((r.por_estado.sin_confirmar ?? 0) > 0
        ? { aviso: "Hay lotes sin confirmar (no se pudo leer la base): no digas que están libres." }
        : {}),
      nota: "El estado se leyó hace menos de 2 minutos; puede cambiar en el día. Precio de lista = financiado.",
    },
  };
}

async function simularCuotasDe(ctx: ContextoAsistente, args: ArgsSimular): Promise<Resultado> {
  if (!esCuentaDeGolden(ctx.accountId)) {
    return { datos: { error: "Esta cuenta no tiene lista de precios ni reglas de financiamiento cargadas en la app." } };
  }
  const datos = await catalogoDeGolden();
  if (!datos) return { datos: { error: "No se pudo leer el catálogo de la app." } };
  return { datos: simularCuotas(datos, args) };
}

/** A quién hay que rescatar hoy: escribieron y se callaron. */
async function quienNoContesta(ctx: ContextoAsistente): Promise<Resultado> {
  const { data: convs, error } = await ctx.db
    .from("conversations")
    .select("id, last_message_at, assigned_agent_id, followup_count, contact:contacts(id, name, phone)")
    .eq("account_id", ctx.accountId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(60);
  if (error) return { datos: { error: error.message } };

  const filas = (convs ?? []) as unknown as {
    id: string;
    last_message_at: string | null;
    assigned_agent_id: string | null;
    followup_count: number | null;
    contact: { id: string; name: string | null; phone: string | null } | null;
  }[];
  if (!filas.length) return { datos: { total: 0, clientes: [] } };

  const voz = await vozDeLosClientes(ctx, filas.map((f) => f.id));
  const quien = await nombresDelEquipo(ctx);

  const callados = filas
    .filter((f) => {
      const v = voz.get(f.id);
      // Escribió alguna vez, y el último en hablar no fue él.
      return v && v.ultimo !== "cliente" && v.dijo.length > 0;
    })
    .map((f) => {
      const v = voz.get(f.id)!;
      const min = f.last_message_at ? Math.round((Date.now() - Date.parse(f.last_message_at)) / 60_000) : null;
      return {
        cliente: f.contact?.name || f.contact?.phone || "Sin nombre",
        telefono: f.contact?.phone,
        lleva: quien.get(f.assigned_agent_id ?? "") ?? "sin asignar",
        horas_callado: min == null ? null : Math.round(min / 60),
        veces_que_se_le_insistio: f.followup_count ?? 0,
        lo_ultimo_que_dijo: v.dijo[v.dijo.length - 1] ?? null,
        senales_de_interes: v.senales,
      };
    })
    .sort((a, b) => (b.horas_callado ?? 0) - (a.horas_callado ?? 0));

  return {
    datos: {
      total: callados.length,
      clientes: callados.slice(0, 20),
      nota: "Pasadas 24 h desde su último mensaje ya no se les puede escribir libremente por WhatsApp: hace falta una plantilla.",
    },
  };
}

/** Cómo va el negocio, en números. */
async function embudo(ctx: ContextoAsistente, args: { dias?: number }): Promise<Resultado> {
  const dias = Math.min(Math.max(Number(args.dias) || 30, 1), 365);
  const desde = new Date(Date.now() - dias * 864e5).toISOString();

  const sinCobranzas = await sinAccesoCobranzas(ctx);
  const [contactos, convs, citas, planes, saldos] = await Promise.all([
    ctx.db.from("contacts").select("id", { count: "exact", head: true }).eq("account_id", ctx.accountId).gte("created_at", desde),
    ctx.db.from("conversations").select("id, status").eq("account_id", ctx.accountId).gte("created_at", desde),
    ctx.db.from("appointments").select("id, status").eq("account_id", ctx.accountId).gte("created_at", desde),
    ctx.db.from("payment_plans").select("id, status").eq("account_id", ctx.accountId),
    ctx.db.from("payment_plan_balances").select("pending_amount, overdue_amount, currency"),
  ]);

  const citasFilas = (citas.data ?? []) as { status: string }[];
  const planesFilas = (planes.data ?? []) as { status: string }[];
  const saldosFilas = (saldos.data ?? []) as { pending_amount: number | null; overdue_amount: number | null; currency: string | null }[];
  const suma = (campo: "pending_amount" | "overdue_amount") =>
    saldosFilas.reduce((t, s) => t + (Number(s[campo]) || 0), 0);

  return {
    datos: {
      periodo: `últimos ${dias} días`,
      contactos_nuevos: contactos.count ?? 0,
      conversaciones_abiertas: ((convs.data ?? []) as { status: string }[]).filter((c) => c.status !== "closed").length,
      citas_agendadas: citasFilas.filter((c) => c.status === "agendada").length,
      citas_canceladas: citasFilas.filter((c) => c.status === "cancelada").length,
      clientes_con_plan_de_pago: planesFilas.filter((p) => p.status === "activo").length,
      planes_ya_pagados: planesFilas.filter((p) => p.status === "pagado").length,
      ...(sinCobranzas
        ? { cobranza: SIN_ACCESO_COBRANZAS }
        : {
            por_cobrar_total: suma("pending_amount").toFixed(2),
            atrasado_total: suma("overdue_amount").toFixed(2),
            moneda: saldosFilas[0]?.currency ?? "PEN",
            nota: "Las cifras de cobranza son del total vigente, no sólo del periodo.",
          }),
    },
  };
}

/** Cuánto lleva y cómo va cada asesor. */
async function rendimientoDelEquipo(ctx: ContextoAsistente, args: { dias?: number }): Promise<Resultado> {
  if (!esJefe(ctx.rol)) {
    return { datos: { error: "Esto sólo lo puede ver un dueño o un administrador." } };
  }
  const dias = Math.min(Math.max(Number(args.dias) || 30, 1), 365);
  const desde = new Date(Date.now() - dias * 864e5).toISOString();

  const [{ data: gente }, { data: convs }, { data: citas }] = await Promise.all([
    ctx.db.from("profiles").select("user_id, full_name, email, account_role, area").eq("account_id", ctx.accountId),
    ctx.db.from("conversations").select("id, assigned_agent_id, status").eq("account_id", ctx.accountId),
    ctx.db
      .from("appointments")
      .select("user_id, status")
      .eq("account_id", ctx.accountId)
      .gte("created_at", desde),
  ]);

  const convFilas = (convs ?? []) as { id: string; assigned_agent_id: string | null; status: string }[];
  const voz = await vozDeLosClientes(ctx, convFilas.map((c) => c.id));

  return {
    datos: {
      periodo: `últimos ${dias} días`,
      asesores: (gente ?? [])
        .filter((p) => p.account_role !== "viewer")
        .map((p) => {
          const suyas = convFilas.filter((c) => c.assigned_agent_id === p.user_id);
          return {
            nombre: (p.full_name as string) || (p.email as string) || "?",
            conversaciones: suyas.length,
            abiertas: suyas.filter((c) => c.status !== "closed").length,
            // Las que esperan respuesta suya: el último que habló fue el cliente.
            sin_responder: suyas.filter((c) => voz.get(c.id)?.ultimo === "cliente").length,
            citas_agendadas: ((citas ?? []) as { user_id: string; status: string }[]).filter(
              (c) => c.user_id === p.user_id && c.status === "agendada",
            ).length,
          };
        })
        .sort((a, b) => b.conversaciones - a.conversaciones),
    },
  };
}

/** Tomar o devolver una conversación desde el asistente. */
async function ponerQuienResponde(
  ctx: ContextoAsistente,
  args: { cliente: string; quien: string },
): Promise<Resultado> {
  const { uno, varios } = await buscarContacto(ctx, args.cliente);
  if (!uno) return { datos: candidatos(varios) };
  const ia = args.quien === "ia";

  const { data: conv } = await ctx.db
    .from("conversations")
    .select("id")
    .eq("contact_id", uno.id)
    .eq("account_id", ctx.accountId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conv) return { datos: { error: "Ese contacto no tiene ninguna conversación." } };

  // Con SU cliente: si la base no le deja verla, no se cambia nada.
  const cambios: Record<string, unknown> = ia
    ? { ai_autoreply_disabled: false, ai_reply_count: 0, ai_resumed_at: new Date().toISOString() }
    : { ai_autoreply_disabled: true };
  let { error } = await ctx.db.from("conversations").update(cambios).eq("id", conv.id);
  if (error && /ai_resumed_at/i.test(error.message)) {
    delete cambios.ai_resumed_at;
    ({ error } = await ctx.db.from("conversations").update(cambios).eq("id", conv.id));
  }
  if (error) return { datos: { error: "No se pudo cambiar quién responde." } };

  return {
    datos: {
      cliente: uno.name || uno.phone,
      responde_ahora: ia ? "la asistente virtual" : "tú",
      // El aviso al cliente lo manda la pantalla del chat, no esto: desde
      // aquí no se le escribe a nadie sin que se vea venir.
      nota: "Se cambió quién responde. Al cliente no se le ha avisado: si quieres que lo sepa, escríbele tú o hazlo desde el chat.",
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

interface ArgsCita {
  cliente: string;
  inicio: string;
  tipo: string;
  minutos?: number;
  notas?: string;
  telefono?: string;
  cliente_nuevo?: boolean;
  enlace?: string;
}

/**
 * El cliente de la cita. Si ya está en el CRM, ése; si viene de otro lado
 * (un referido, un conocido, otra inmobiliaria) se registra en el momento
 * con lo que dieron, para que la cita tenga a quién mostrar en la agenda.
 * El teléfono manda: si ya existe alguien con ese número, es esa persona.
 */
async function clienteDeLaCita(
  ctx: ContextoAsistente,
  args: ArgsCita,
): Promise<{ contacto: ContactoEncontrado; nuevo: boolean } | { datos: unknown }> {
  const digitos = (args.telefono ?? "").replace(/\D/g, "");
  if (digitos.length >= 6) {
    const { uno } = await buscarContacto(ctx, digitos);
    if (uno) return { contacto: uno, nuevo: false };
  }

  if (!args.cliente_nuevo) {
    const { uno, varios } = await buscarContacto(ctx, args.cliente);
    if (uno) return { contacto: uno, nuevo: false };
    if (varios?.length) {
      return {
        datos: {
          ...candidatos(varios),
          si_no_es_ninguno:
            "Si es otra persona, vuelve a llamar con cliente_nuevo=true (y su teléfono si lo tienen) para registrarla y agendarla.",
        },
      };
    }
  }

  // Sólo números en "cliente" y sin teléfono aparte: eso es el teléfono.
  const soloNumero = /^[\d\s+()-]+$/.test(args.cliente.trim());
  const nombre = soloNumero ? null : args.cliente.trim().slice(0, 120) || null;
  const telefono = digitos || (soloNumero ? args.cliente.replace(/\D/g, "") : "");
  if (!nombre && !telefono) return { datos: { error: "Falta el nombre o el teléfono del cliente." } };

  const { data, error } = await ctx.db
    .from("contacts")
    .insert({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      name: nombre,
      // `phone` no admite nulo; vacío queda fuera del índice único (022).
      phone: telefono,
      lead_source: "externo",
    })
    .select("id, name, phone, email")
    .single();
  if (error) {
    // Alguien registró ese número entre la búsqueda y ahora.
    if ((error as { code?: string }).code === "23505" && telefono) {
      const { uno } = await buscarContacto(ctx, telefono);
      if (uno) return { contacto: uno, nuevo: false };
    }
    return { datos: { error: `No se pudo registrar al cliente: ${error.message}` } };
  }
  return { contacto: data as ContactoEncontrado, nuevo: true };
}

async function agendarCita(ctx: ContextoAsistente, args: ArgsCita): Promise<Resultado> {
  // Sin zona, es hora de Lima (no la del servidor).
  const cuando = fechaLima(args.inicio);
  if (Number.isNaN(cuando)) return { datos: { error: "La fecha y hora no se entendieron." } };
  if (cuando < Date.now() - 5 * 60_000) return { datos: { error: "Esa hora ya pasó." } };

  const quien = await clienteDeLaCita(ctx, args);
  if ("datos" in quien) return { datos: quien.datos };
  const { contacto: uno, nuevo } = quien;

  const tipo = ["videollamada", "visita", "llamada"].includes(args.tipo) ? args.tipo : "videollamada";
  const enlace = /^https?:\/\/\S+$/i.test(args.enlace?.trim() ?? "") ? args.enlace!.trim() : null;
  // Con un enlace propio (Zoom, Meet) no se abre la sala de Golden: el
  // enlace va en las notas, que es lo que se ve en la agenda.
  const sala = tipo === "videollamada" && !enlace ? `golden-${uno.id.replace(/-/g, "").slice(0, 18)}` : null;
  const notas = [enlace ? `Enlace: ${enlace}` : "", args.notas?.trim() ?? ""].filter(Boolean).join("\n");
  const { data, error } = await ctx.db
    .from("appointments")
    .insert({
      account_id: ctx.accountId,
      contact_id: uno.id,
      user_id: ctx.userId,
      starts_at: new Date(cuando).toISOString(),
      minutes: Math.min(Math.max(Number(args.minutos) || 30, 10), 240),
      kind: tipo,
      room: sala,
      notes: notas.slice(0, 500) || null,
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
  // Que le suene al cliente si tiene la app; el recién registrado no la tiene.
  if (!nuevo) {
    await notifyClient(supabaseAdmin(), {
      contactId: uno.id,
      title: await marcaDeLaCuenta(ctx.accountId),
      body: `Tienes una ${texto}. La ves en la pestaña Citas.`,
    }).catch(() => {});
  }

  // El cliente de fuera no ve la app: el enlace se lo tiene que pasar el asesor.
  const base = (process.env.NEXT_PUBLIC_VIDEO_BASE || "https://meet.jit.si").replace(/\/+$/, "");
  return {
    datos: {
      ok: true,
      cliente: uno.name || uno.phone,
      cita: texto,
      ...(nuevo ? { registrado_nuevo: "No estaba en el CRM: quedó registrado con esta cita." } : {}),
      ...(enlace || sala ? { enlace_para_el_cliente: enlace || `${base}/${sala}` } : {}),
    },
    accion: { tipo: "cita_agendada", detalle: `${uno.name || uno.phone}: ${texto}` },
  };
}

async function cuotasAtrasadas(ctx: ContextoAsistente): Promise<Resultado> {
  if (await sinAccesoCobranzas(ctx)) return { datos: { error: SIN_ACCESO_COBRANZAS } };
  const { data, error } = await ctx.db
    .from("installments")
    .select("id, number, amount, due_date, plan:payment_plans(currency, contact:contacts(name, phone))")
    .eq("account_id", ctx.accountId)
    .eq("status", "pendiente")
    .lt("due_date", hoyLima())
    .order("due_date")
    .limit(30);
  if (error) return { datos: { error: error.message } };
  // Saldo real por cuota (084); sin la vista queda el monto.
  const ids = (data ?? []).map((c) => c.id as string);
  const { data: faltan, error: errFaltan } = ids.length
    ? await ctx.db.from("installment_balances").select("installment_id, remaining").in("installment_id", ids)
    : { data: [], error: null };
  const restante = new Map<string, number>(
    errFaltan ? [] : (faltan ?? []).map((x) => [x.installment_id as string, Number(x.remaining)] as [string, number]),
  );
  return {
    datos: {
      total: (data ?? []).length,
      cuotas: (data ?? []).map((c) => {
        const plan = c.plan as unknown as { currency: string; contact: { name: string | null; phone: string | null } | null } | null;
        return {
          cliente: plan?.contact?.name || plan?.contact?.phone || "Cliente",
          cuota: c.number,
          monto: `${plan?.currency ?? ""} ${(restante.get(c.id as string) ?? Number(c.amount)).toFixed(2)}`,
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

interface ArgsCambiarCita {
  cliente: string;
  nuevo_inicio?: string;
  estado?: string;
}

/** Corrige la próxima cita pendiente de un cliente (hora, cumplida o cancelada). */
async function cambiarCita(ctx: ContextoAsistente, args: ArgsCambiarCita): Promise<Resultado> {
  const pedido = pedidoDeCambioDeCita(args, Date.now());
  if ("error" in pedido) return { datos: { error: pedido.error } };

  const { uno, varios } = await buscarContacto(ctx, args.cliente);
  if (!uno) return { datos: candidatos(varios) };

  // La próxima pendiente; si no hay, la última pendiente que ya pasó (para
  // marcar "vino" el día después).
  const { data: citas, error } = await ctx.db
    .from("appointments")
    .select("id, starts_at, kind, status")
    .eq("account_id", ctx.accountId)
    .eq("contact_id", uno.id)
    .eq("status", "agendada")
    .order("starts_at", { ascending: true });
  if (error) return { datos: { error: `No se pudo leer la agenda: ${error.message}` } };
  const cita = elegirCitaACorregir((citas ?? []) as { id: string; starts_at: string }[], Date.now());
  if (!cita) return { datos: { error: `${uno.name || uno.phone} no tiene citas pendientes en la agenda.` } };

  const cambios: Record<string, unknown> = {};
  if (pedido.inicio) cambios.starts_at = new Date(pedido.inicio).toISOString();
  if (pedido.estado) cambios.status = pedido.estado;
  const { data: hecha, error: errCambio } = await ctx.db
    .from("appointments")
    .update(cambios)
    .eq("id", cita.id)
    .eq("account_id", ctx.accountId)
    .select("id, starts_at, kind, status")
    .maybeSingle();
  if (errCambio) {
    return {
      datos: {
        error: (errCambio as { code?: string }).code === "23505"
          ? "A esa hora ya hay otra cita de la misma persona del equipo."
          : `No se pudo cambiar: ${errCambio.message}`,
      },
    };
  }
  if (!hecha) return { datos: { error: "No tienes permiso para cambiar esa cita." } };

  const quien = uno.name || uno.phone;
  const texto =
    pedido.estado === "cumplida"
      ? `${quien}: cita marcada como cumplida`
      : pedido.estado === "cancelada"
        ? `${quien}: cita cancelada`
        : `${quien}: ${nombreDeCita(hecha.kind as string)} pasada al ${cuandoLima(hecha.starts_at as string)}`;
  return {
    datos: {
      ok: true,
      cliente: quien,
      cita: `${nombreDeCita(hecha.kind as string)} el ${cuandoLima(hecha.starts_at as string)}`,
      estado: hecha.status,
      ...(pedido.inicio ? { aviso: "Al cliente no se le avisó solo: díselo por su chat." } : {}),
    },
    accion: { tipo: "cita_cambiada", detalle: texto },
  };
}

/** Mueve a un cliente de etapa (a mano: puede retroceder). */
async function moverEtapaDe(ctx: ContextoAsistente, args: { cliente: string; etapa: string }): Promise<Resultado> {
  const clave = claveDeEtapa(args.etapa);
  if (!clave) {
    return { datos: { error: "No entendí la etapa. Puede ser: nuevo, contestó, seguimiento, agendó, visitó, separó/compró o perdido." } };
  }
  if (!(await cuentaConEtapas(ctx.db, ctx.accountId))) {
    return { datos: { error: "Esta cuenta todavía no tiene etapas de clientes configuradas." } };
  }
  const { uno, varios } = await buscarContacto(ctx, args.cliente);
  if (!uno) return { datos: candidatos(varios) };
  const quedo = await moverEtapa(ctx.db, { accountId: ctx.accountId, contactId: uno.id, clave, forzar: true });
  if (!quedo) return { datos: { error: "No se pudo mover la etapa." } };
  const nombre = NOMBRE_DE_ETAPA[quedo as ClaveDeEtapa] ?? quedo;
  return {
    datos: { ok: true, cliente: uno.name || uno.phone, etapa: nombre },
    accion: { tipo: "etapa_movida", detalle: `${uno.name || uno.phone} → ${nombre}` },
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
      case "resumen_de_conversacion":
        return await resumenDeConversacion(ctx, args as { cliente: string });
      case "buscar_lote":
        return await buscarLote(ctx, args as ArgsBuscarLote);
      case "simular_cuotas":
        return await simularCuotasDe(ctx, args as ArgsSimular);
      case "quien_no_contesta":
        return await quienNoContesta(ctx);
      case "embudo":
        return await embudo(ctx, args as { dias?: number });
      case "rendimiento_del_equipo":
        return await rendimientoDelEquipo(ctx, args as { dias?: number });
      case "poner_quien_responde":
        return await ponerQuienResponde(ctx, args as { cliente: string; quien: string });
      case "mi_agenda":
        return await miAgenda(ctx, args as { desde?: string; hasta?: string; de_todo_el_equipo?: boolean });
      case "horas_libres":
        return await horasLibres(ctx, args as { dias?: number });
      case "agendar_cita":
        return await agendarCita(ctx, args as unknown as ArgsCita);
      case "cuotas_atrasadas":
        return await cuotasAtrasadas(ctx);
      case "agregar_nota":
        return await agregarNota(ctx, args as { cliente: string; texto: string });
      case "cambiar_cita":
        return await cambiarCita(ctx, args as unknown as ArgsCambiarCita);
      case "mover_etapa":
        return await moverEtapaDe(ctx, args as { cliente: string; etapa: string });
      default:
        return { datos: { error: `Herramienta desconocida: ${nombre}` } };
    }
  } catch (err) {
    console.error(`[assistant] tool ${nombre} failed:`, err);
    return { datos: { error: "Algo falló al consultar el CRM." } };
  }
}
