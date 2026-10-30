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
import { canalDe } from "@/lib/channels";
import { emparejarAsesor, leerSeparaciones, ventasDeSeparaciones } from "@/lib/golden/ventas";
import { armarDiaDeCombi, type AsientoDeCombi, type SalidaDeCombi } from "./combi";
import {
  armarActivos,
  armarRanking,
  estaEnLinea,
  indicesDeActividad,
  rangoDePeriodo,
  sumarVenta,
  ventasEnCero,
  type Periodo,
  type VentasDeAlguien,
} from "./rendimiento";
import {
  TIPOS_DE_MATERIAL,
  buscarProyecto,
  elegirMaterial,
  materialDisponible,
  ventanaDelCliente,
  type AdjuntoMaterial,
  type ComandoDeEnvio,
  type EnvioPropuesto,
  type TipoDeMaterial,
} from "./material";

export interface ContextoAsistente {
  db: SupabaseClient;
  userId: string;
  accountId: string;
  rol: string;
  area: string | null;
  nombre: string;
  /** Por WhatsApp hay botones y archivos; en la app, sólo texto y enlaces. */
  canal: "whatsapp" | "app";
}

export interface Accion {
  tipo: "cita_agendada" | "nota_guardada";
  detalle: string;
}

interface Resultado {
  datos: unknown;
  accion?: Accion;
  /** Archivos para quien pregunta: los manda el canal, después del texto. */
  adjuntos?: AdjuntoMaterial[];
  /** Un envío a un cliente que espera el botón de quien pregunta. */
  envio?: EnvioPropuesto;
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
      name: "enviar_material",
      description:
        "Envía el brochure, el video o la foto de un proyecto. Sin `cliente`, los archivos le llegan a quien pregunta. Con `cliente`, NO envía nada: arma un borrador y quien pregunta tiene que tocar el botón 'Sí, enviar'. Úsala cuando pidan 'mándame el brochure de...' o 'envíale el video a...'.",
      parameters: {
        type: "object",
        properties: {
          proyecto: { type: "string", description: "Nombre del proyecto, p. ej. 'Casa Jade'." },
          tipos: {
            type: "array",
            items: { type: "string", enum: TIPOS_DE_MATERIAL },
            minItems: 1,
            description: "Qué enviar. 'foto' es la foto de portada.",
          },
          cliente: { type: "string", description: "Nombre, teléfono o DNI del cliente. Vacío = a quien pregunta." },
          mensaje: {
            type: "string",
            maxLength: 1024,
            description: "Sólo con `cliente`: el texto que acompaña al primer archivo. Escríbelo sólo si te lo pidieron.",
          },
        },
        required: ["proyecto", "tipos"],
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
        "Busca lotes concretos en los planos de la app: por proyecto, por manzana o por metraje, y dice cuáles están libres. Para contestar '¿qué te queda de 200 m²?' o '¿está libre el A-12?'.",
      parameters: {
        type: "object",
        properties: {
          proyecto: { type: "string", description: "Nombre del proyecto, p. ej. 'Colinas II'. Vacío = todos." },
          manzana: { type: "string", description: "Letra de la manzana, p. ej. 'K'." },
          area_minima: { type: "number", description: "Metros cuadrados mínimos." },
          area_maxima: { type: "number", description: "Metros cuadrados máximos." },
          lote: { type: "string", description: "Código exacto de un lote, p. ej. 'A-12'." },
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
        "Ranking de asesores por VENTAS (separaciones de lotes aprobadas y reservas), con importe, mensajes recibidos y enviados, chats, sin responder, citas, tiempo en la app e índice de actividad. Úsala para '¿quién vende más?', '¿quién tiene mejor rendimiento?', '¿cuántos mensajes le llegaron a Sara?', '¿cómo va Golden 1?'. Sólo para dueño o administrador.",
      parameters: {
        type: "object",
        properties: {
          periodo: { type: "string", enum: ["hoy", "semana", "mes"], description: "Por defecto, el mes actual." },
          desde: { type: "string", description: "En vez de periodo: primer día, YYYY-MM-DD (hora de Lima)." },
          hasta: { type: "string", description: "Último día, YYYY-MM-DD, inclusive." },
          asesor: { type: "string", description: "Nombre de un asesor para ver sólo el suyo, con el detalle de sus ventas." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "quien_esta_activo",
      description:
        "Quién del equipo está conectado ahora mismo, cuándo entró por última vez cada uno, cuántos minutos lleva hoy en la app y cuántos clientes abrieron la app en las últimas 24 h. Sólo para dueño o administrador.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "combi_del_dia",
      description:
        "Las salidas de la combi de un día: a qué hora, a qué proyecto, cómo va el viaje, cuántos asientos quedan y quién va en cada asiento, con su asesor. También los horarios programados sin pasajeros. Úsala para '¿a qué hora sale la combi?', '¿con quién va?', '¿hay sitio mañana?'.",
      parameters: {
        type: "object",
        properties: {
          fecha: { type: "string", description: "YYYY-MM-DD en hora de Lima. Vacío = hoy." },
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

  const [{ data: saldo }, { data: citas }] = await Promise.all([
    ctx.db
      .from("payment_plan_balances")
      .select("currency, pending_amount, overdue_count, next_due_date")
      .eq("contact_id", uno.id)
      .maybeSingle(),
    ctx.db
      .from("appointments")
      .select("starts_at, kind, status")
      .eq("contact_id", uno.id)
      .eq("status", "agendada")
      .gte("starts_at", new Date().toISOString())
      .order("starts_at")
      .limit(2),
  ]);

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
      ya_es_cliente: Boolean(saldo),
      ...(saldo
        ? {
            por_pagar: `${saldo.currency === "PEN" ? "S/" : saldo.currency} ${Number(saldo.pending_amount ?? 0).toFixed(2)}`,
            cuotas_atrasadas: saldo.overdue_count ?? 0,
            proxima_cuota: saldo.next_due_date ?? null,
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
  args: { proyecto?: string; manzana?: string; area_minima?: number; area_maxima?: number; lote?: string },
): Promise<Resultado> {
  const datos = await catalogoDeGolden();
  if (!datos) return { datos: { error: "No se pudo leer el catálogo de la app." } };

  const buscadoProyecto = (args.proyecto ?? "").trim().toLowerCase();
  const mz = (args.manzana ?? "").trim().toUpperCase().replace(/^MZ\.?\s*/i, "");
  const codigo = (args.lote ?? "").trim().toUpperCase();

  const proyectos = datos.proyectos.filter(
    (p) =>
      p.lotes?.length &&
      (!buscadoProyecto ||
        `${p.nombre} ${p.nombreCorto ?? ""}`.toLowerCase().includes(buscadoProyecto)),
  );

  const encontrados: Record<string, unknown>[] = [];
  for (const p of proyectos) {
    for (const l of p.lotes ?? []) {
      if (codigo && l.id.toUpperCase() !== codigo) continue;
      if (mz && (l.mz ?? "").toUpperCase() !== mz) continue;
      if (args.area_minima && (l.area ?? 0) < args.area_minima) continue;
      if (args.area_maxima && (l.area ?? 0) > args.area_maxima) continue;
      encontrados.push({
        proyecto: p.nombreCorto || p.nombre,
        lote: l.id,
        manzana: l.mz,
        area: l.area,
        estado: l.estado,
        precio_del_proyecto_desde: p.comercial.precioDesde,
        moneda: p.comercial.moneda,
      });
    }
  }

  const libres = encontrados.filter((l) => l.estado === "libre");
  return {
    datos: {
      total_encontrados: encontrados.length,
      libres: libres.length,
      // Una lista larga no la va a leer nadie por WhatsApp: se dan los
      // primeros y el recuento, que es lo que se usa para contestar.
      lotes: (libres.length ? libres : encontrados).slice(0, 25),
      nota: "El estado de un lote cambia durante el día: confírmalo con el asesor antes de prometérselo a nadie.",
    },
  };
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
      por_cobrar_total: suma("pending_amount").toFixed(2),
      atrasado_total: suma("overdue_amount").toFixed(2),
      moneda: saldosFilas[0]?.currency ?? "PEN",
      nota: "Las cifras de cobranza son del total vigente, no sólo del periodo.",
    },
  };
}

/** Cuánto lleva y cómo va cada asesor. */
const SOLO_JEFES = { datos: { error: "Esto sólo lo puede ver un dueño o un administrador." } };

/** Las conversaciones de la cuenta, las más recientes primero. PostgREST corta en mil por consulta. */
async function conversacionesDeLaCuenta(ctx: ContextoAsistente) {
  const filas: { id: string; assigned_agent_id: string | null; status: string; unread_count: number | null }[] = [];
  for (let i = 0; ; i += 1000) {
    const { data } = await ctx.db
      .from("conversations")
      .select("id, assigned_agent_id, status, unread_count")
      .eq("account_id", ctx.accountId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("id")
      .range(i, i + 999);
    filas.push(...((data ?? []) as typeof filas));
    if ((data ?? []).length < 1000) return filas;
  }
}

async function rendimientoDelEquipo(
  ctx: ContextoAsistente,
  args: { periodo?: Periodo; desde?: string; hasta?: string; asesor?: string },
): Promise<Resultado> {
  if (!esJefe(ctx.rol)) return SOLO_JEFES;
  const rango = rangoDePeriodo(args);

  const [{ data: gente }, convs, actividad, { data: citas }, { data: presencia }, { data: uso }, { data: reservas }, separaciones] =
    await Promise.all([
      ctx.db.from("profiles").select("id, user_id, full_name, email, account_role").eq("account_id", ctx.accountId),
      conversacionesDeLaCuenta(ctx),
      ctx.db.rpc("actividad_del_equipo", { p_cuenta: ctx.accountId, p_desde: rango.desde, p_hasta: rango.hasta }),
      ctx.db
        .from("appointments")
        .select("user_id, status, starts_at")
        .eq("account_id", ctx.accountId)
        .gte("starts_at", rango.desde)
        .lt("starts_at", rango.hasta),
      ctx.db.from("member_presence").select("user_id, last_seen_at").eq("account_id", ctx.accountId),
      ctx.db.from("uso_app").select("user_id, dia, minutos").eq("account_id", ctx.accountId).gte("dia", rango.diaDesde).lte("dia", rango.diaHasta),
      ctx.db
        .from("reservations")
        .select("advisor_id, total_amount, currency, approved_at")
        .eq("account_id", ctx.accountId)
        .in("status", ["aprobada", "cerrada"])
        .gte("approved_at", rango.desde)
        .lt("approved_at", rango.hasta),
      leerSeparaciones(),
    ]);

  const miembros = ((gente ?? []) as { id: string; user_id: string; full_name: string | null; email: string | null; account_role: string }[]).filter(
    (p) => p.account_role !== "viewer",
  );

  // Las ventas: separaciones aprobadas (el asesor está escrito a mano) y reservas.
  const ventas = new Map(miembros.map((m) => [m.user_id, ventasEnCero()]));
  const detalle = new Map<string, unknown[]>();
  const sinCoincidir = new Map<string, VentasDeAlguien>();
  const apuntar = (userId: string | null, escrito: string, venta: { importe: number | null; moneda: string; que: string; fecha: string | null }) => {
    if (userId && ventas.has(userId)) {
      sumarVenta(ventas.get(userId)!, venta);
      detalle.set(userId, [...(detalle.get(userId) ?? []), { que: venta.que, importe: venta.importe, moneda: venta.moneda, fecha: venta.fecha && cuandoLima(venta.fecha) }]);
      return;
    }
    if (!sinCoincidir.has(escrito)) sinCoincidir.set(escrito, ventasEnCero());
    sumarVenta(sinCoincidir.get(escrito)!, venta);
  };

  if (separaciones.estado === "ok") {
    for (const f of ventasDeSeparaciones(separaciones.filas, separaciones.estados, rango)) {
      apuntar(emparejarAsesor(f.asesor, miembros), f.asesor, {
        importe: f.precio_lote === null ? null : Number(f.precio_lote),
        moneda: f.moneda,
        que: `Lote ${f.lote} de ${f.proyecto}`,
        fecha: f.resuelta,
      });
    }
  }
  const perfilAUsuario = new Map(miembros.map((m) => [m.id, m.user_id]));
  for (const r of (reservas ?? []) as { advisor_id: string | null; total_amount: number; currency: string; approved_at: string }[]) {
    apuntar(perfilAUsuario.get(r.advisor_id ?? "") ?? null, "Reserva sin asesor", {
      importe: Number(r.total_amount) > 0 ? Number(r.total_amount) : null,
      moneda: r.currency,
      que: "Reserva del CRM",
      fecha: r.approved_at,
    });
  }

  // La actividad: lo que en la pantalla Control se ve de cada uno.
  const mensajes = new Map(
    ((actividad.data ?? []) as { user_id: string; recibidos: number; enviados: number; chats: number; dias: string[] }[]).map((a) => [a.user_id, a]),
  );
  const abiertas = convs.filter((c) => c.assigned_agent_id && c.status !== "closed");
  // Sólo las más recientes: la consulta de los últimos mensajes tiene un tope.
  const voz = await vozDeLosClientes(ctx, abiertas.slice(0, 200).map((c) => c.id));
  const visto = new Map(((presencia ?? []) as { user_id: string; last_seen_at: string }[]).map((p) => [p.user_id, p.last_seen_at]));
  const usoFilas = (uso ?? []) as { user_id: string; dia: string; minutos: number }[];
  const citaFilas = (citas ?? []) as { user_id: string; status: string; starts_at: string }[];
  const diaLima = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: LIMA }).format(new Date(iso));

  const personas = miembros.map((m) => {
    const suyas = convs.filter((c) => c.assigned_agent_id === m.user_id);
    const susCitas = citaFilas.filter((c) => c.user_id === m.user_id);
    const suyoUso = usoFilas.filter((u) => u.user_id === m.user_id);
    const movio = mensajes.get(m.user_id);
    const canceladas = susCitas.filter((c) => c.status === "cancelada").length;
    return {
      userId: m.user_id,
      nombre: m.full_name || m.email || "?",
      ventas: ventas.get(m.user_id)!,
      enviados: Number(movio?.enviados ?? 0),
      recibidos: Number(movio?.recibidos ?? 0),
      chats_con_movimiento: Number(movio?.chats ?? 0),
      chats_asignados: suyas.length,
      sin_leer: suyas.reduce((n, c) => n + (Number(c.unread_count) || 0), 0),
      sin_responder: suyas.filter((c) => voz.get(c.id)?.ultimo === "cliente").length,
      citas: { total: susCitas.length, cumplidas: susCitas.filter((c) => c.status === "cumplida").length, canceladas },
      minutos_app: suyoUso.reduce((n, u) => n + (Number(u.minutos) || 0), 0),
      dias_activos: new Set([
        ...suyoUso.map((u) => u.dia),
        ...(movio?.dias ?? []),
        ...susCitas.filter((c) => c.status !== "cancelada").map((c) => diaLima(c.starts_at)),
      ]).size,
      ultima_conexion: visto.get(m.user_id) ? cuandoLima(visto.get(m.user_id)!) : null,
      en_linea: estaEnLinea(visto.get(m.user_id)),
    };
  });
  const indices = indicesDeActividad(personas);
  const ranking = armarRanking(personas.map((p, i) => ({ ...p, indice_actividad: indices[i] }))).map(({ userId, enviados, recibidos, ...p }) => ({
    ...p,
    userId,
    // Sin la 080 no se sabe: un cero sería decir que no recibió ninguno.
    mensajes: actividad.error ? null : { recibidos, enviados },
  }));

  const avisos: Record<string, string> = {};
  if (actividad.error) {
    if (actividad.error.code === "42883" || actividad.error.code === "PGRST202") {
      avisos.falta_migracion = "Falta correr la migración 080 en el CRM: por eso no hay mensajes ni índice completo.";
    } else {
      avisos.mensajes_no_disponibles = "No se pudieron contar los mensajes ahora.";
    }
  }
  if (separaciones.estado !== "ok") {
    avisos.ventas_no_disponibles =
      separaciones.estado === "sin_clave"
        ? "No se pudieron leer las separaciones: falta GOLDEN_SUPABASE_SERVICE_KEY en el CRM. Sólo se ven las reservas del CRM."
        : "No se pudieron leer las separaciones ahora: el Supabase de la app no respondió. Sólo se ven las reservas del CRM.";
  }
  const sin_coincidir = [...sinCoincidir].map(([escrito, v]) => ({ escrito_como: escrito, ...v }));
  const periodo = `${rango.diaDesde} a ${rango.diaHasta}`;

  if (args.asesor?.trim()) {
    const id = emparejarAsesor(args.asesor, miembros);
    const uno = ranking.find((p) => p.userId === id);
    if (!uno) {
      return {
        datos: {
          asesor_no_encontrado: args.asesor,
          equipo: ranking.map((p) => p.nombre),
          sin_coincidir,
          nota: "Nadie del equipo se llama así, o hay más de uno. Pregunta cuál de la lista es. `sin_coincidir` son ventas escritas con un nombre que no se pudo atribuir.",
        },
      };
    }
    const { userId, ...datos } = uno;
    return { datos: { periodo, ...datos, de_cuantos: ranking.length, ventas_detalle: (detalle.get(userId) ?? []).slice(0, 20), ...avisos } };
  }

  return {
    datos: {
      periodo,
      // Sin las separaciones no se sabe quién vendió más: no se nombra a nadie.
      mejor_vendedor: separaciones.estado === "ok" && ranking[0]?.ventas.cantidad ? ranking[0].nombre : null,
      ranking: ranking.map((p) => ({ ...p, userId: undefined })),
      sin_coincidir,
      ...avisos,
    },
  };
}

async function quienEstaActivo(ctx: ContextoAsistente): Promise<Resultado> {
  if (!esJefe(ctx.rol)) return SOLO_JEFES;
  const [{ data: gente }, { data: presencia }, { data: uso }, { data: sesiones }] = await Promise.all([
    ctx.db.from("profiles").select("user_id, full_name, email, account_role").eq("account_id", ctx.accountId),
    ctx.db.from("member_presence").select("user_id, last_seen_at").eq("account_id", ctx.accountId),
    ctx.db.from("uso_app").select("user_id, minutos").eq("account_id", ctx.accountId).eq("dia", hoyLima()),
    // client_sessions no tiene políticas: sólo la lee el servidor (045).
    supabaseAdmin()
      .from("client_sessions")
      .select("contact_id")
      .eq("account_id", ctx.accountId)
      .is("revoked_at", null)
      .gte("last_seen_at", new Date(Date.now() - 864e5).toISOString())
      .limit(1000),
  ]);
  const equipo = armarActivos(gente ?? [], presencia ?? [], uso ?? []).map((p) => ({
    ...p,
    ultima_conexion: p.ultima_conexion ? cuandoLima(p.ultima_conexion) : null,
  }));
  return {
    datos: {
      conectados_ahora: equipo.filter((p) => p.en_linea).map((p) => p.nombre),
      equipo,
      clientes_que_abrieron_la_app_en_24_h: new Set((sesiones ?? []).map((s) => s.contact_id)).size,
      nota: "Del equipo se sabe quién está ahora. De los clientes sólo cuántos entraron en las últimas 24 h: no se puede saber quién está dentro en este momento.",
    },
  };
}

async function combiDelDia(ctx: ContextoAsistente, args: { fecha?: string }): Promise<Resultado> {
  const fecha = args.fecha && /^\d{4}-\d{2}-\d{2}$/.test(args.fecha) ? args.fecha : hoyLima();
  const { data: salidas, error } = await ctx.db
    .from("combi_salidas")
    .select("id, hora, proyecto, capacidad, nota, salio_at, llego_at, visito_at, volvio_at")
    .eq("account_id", ctx.accountId)
    .eq("fecha", fecha)
    .order("hora");
  if (error) return { datos: { error: "No se pudo leer la combi." } };

  const lista = (salidas ?? []) as SalidaDeCombi[];
  const mapas = new Map<string, AsientoDeCombi[]>();
  await Promise.all(
    lista.map(async (s) => {
      const { data } = await ctx.db.rpc("combi_mapa", { p_salida: s.id });
      mapas.set(s.id, (data ?? []) as AsientoDeCombi[]);
    }),
  );

  const combi = (await catalogoDeGolden())?.combi;
  const { data: novedades } = esJefe(ctx.rol)
    ? await ctx.db
        .from("combi_novedades")
        .select("tipo, texto, resuelta")
        .eq("account_id", ctx.accountId)
        .gte("created_at", new Date(`${fecha}T00:00:00-05:00`).toISOString())
        .lt("created_at", new Date(new Date(`${fecha}T00:00:00-05:00`).getTime() + 864e5).toISOString())
    : { data: null };

  return {
    datos: {
      ...armarDiaDeCombi(fecha, lista, mapas, combi?.horarios),
      horarios_provisionales: Boolean(combi?.provisional),
      novedades_del_conductor: novedades ?? [],
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
  const cuando = Date.parse(args.inicio);
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
      title: "Golden Habitat",
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
/**
 * Prepara el material de un proyecto. A un cliente nunca le llega desde aquí:
 * se guarda un borrador y lo envía el botón (asistentes-whatsapp/equipo.ts),
 * después de que la persona vea el destinatario, los archivos y el texto.
 */
async function enviarMaterial(
  ctx: ContextoAsistente,
  args: { proyecto: string; tipos?: TipoDeMaterial[]; cliente?: string; mensaje?: string },
): Promise<Resultado> {
  const datos = await catalogoDeGolden();
  const base = process.env.GOLDEN_APP_URL?.trim();
  if (!datos || !base) {
    return { datos: { error: "No se pudo leer el catálogo de la app. Falta GOLDEN_APP_URL en el CRM, o la app no respondió." } };
  }

  const { uno: proyecto, varios } = buscarProyecto(datos.proyectos, args.proyecto ?? "");
  if (!proyecto) {
    return { datos: { ambiguo: true, opciones: (varios ?? []).map((p) => p.nombre) } };
  }

  const tipos = [...new Set(args.tipos ?? [])];
  const adjuntos: AdjuntoMaterial[] = [];
  const faltan: TipoDeMaterial[] = [];
  for (const tipo of tipos) {
    const adjunto = elegirMaterial(proyecto, tipo, base);
    if (adjunto) adjuntos.push(adjunto);
    else faltan.push(tipo);
  }
  if (!adjuntos.length) {
    return { datos: { sin_material: true, proyecto: proyecto.nombre, faltan, tiene: materialDisponible(proyecto) } };
  }

  const cliente = args.cliente?.trim();
  if (!cliente) {
    if (ctx.canal === "app") {
      return {
        datos: {
          proyecto: proyecto.nombre,
          enlaces: adjuntos.map((a) => ({ que: a.etiqueta, enlace: a.url })),
          faltan,
        },
      };
    }
    return {
      datos: {
        ok: true,
        proyecto: proyecto.nombre,
        llegan_despues_de_tu_respuesta: adjuntos.map((a) => a.etiqueta),
        faltan,
      },
      adjuntos,
    };
  }

  if (ctx.canal !== "whatsapp") {
    return { datos: { error: "Enviarle algo a un cliente sólo se puede desde WhatsApp, donde está el botón para confirmarlo." } };
  }
  const mensaje = args.mensaje?.trim() || null;
  if (mensaje && mensaje.length > 1024) {
    return { datos: { error: "El mensaje pasa de 1024 caracteres, el límite de WhatsApp. Acórtalo." } };
  }

  const { uno: contacto, varios: otros } = await buscarContacto(ctx, cliente);
  if (!contacto) return { datos: candidatos(otros) };

  const { data: conversacion } = await ctx.db
    .from("conversations")
    .select("*")
    .eq("account_id", ctx.accountId)
    .eq("contact_id", contacto.id)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (!conversacion) {
    return { datos: { sin_conversacion: true, nota: `${contacto.name ?? "Este contacto"} nunca nos escribió: WhatsApp no deja mandarle nada sin una plantilla.` } };
  }

  const canal = canalDe(conversacion);
  const ventana = await ventanaDelCliente(ctx.db, conversacion.id as string, canal);
  if (!ventana.abierta) {
    return {
      datos: {
        ventana_cerrada: true,
        cliente: contacto.name,
        ultimo_mensaje_del_cliente: ventana.ultimoMensaje ? cuandoLima(ventana.ultimoMensaje) : "nunca",
        nota: "Pasaron más de 24 h desde su último mensaje: WhatsApp no deja enviarle esto sin una plantilla. No se envió nada.",
      },
    };
  }

  const dueno = conversacion.assigned_agent_id as string | null;
  const propuesta: Omit<EnvioPropuesto, "id"> = {
    cliente: contacto.name ?? contacto.phone ?? "Cliente",
    telefono: contacto.phone,
    asesor: dueno ? ((await nombresDelEquipo(ctx)).get(dueno) ?? null) : null,
    etiquetas: adjuntos.map((a) => a.etiqueta),
    mensaje,
  };
  const comando: ComandoDeEnvio = {
    tipo: "envio_cliente",
    conversacionId: conversacion.id as string,
    canal,
    adjuntos,
    mensaje,
  };
  // Los borradores no tienen políticas: sólo los toca el servidor (075).
  const { data: borrador, error } = await supabaseAdmin()
    .from("whatsapp_team_drafts")
    .insert({ account_id: ctx.accountId, user_id: ctx.userId, command: comando, summary: JSON.stringify(propuesta) })
    .select("id")
    .single();
  if (error || !borrador) return { datos: { error: "No pude guardar el borrador. Intenta de nuevo." } };

  return {
    datos: {
      borrador_listo: true,
      faltan,
      instruccion: "Todavía no se envió nada. Dile sólo que revise y toque Sí, enviar: un 'sí' escrito NO envía.",
    },
    envio: { id: borrador.id as string, ...propuesta },
  };
}

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
      case "enviar_material":
        return await enviarMaterial(ctx, args as { proyecto: string; tipos?: TipoDeMaterial[]; cliente?: string; mensaje?: string });
      case "equipo":
        return await equipo(ctx);
      case "resumen_de_conversacion":
        return await resumenDeConversacion(ctx, args as { cliente: string });
      case "buscar_lote":
        return await buscarLote(ctx, args as { proyecto?: string; manzana?: string; area_minima?: number; area_maxima?: number; lote?: string });
      case "quien_no_contesta":
        return await quienNoContesta(ctx);
      case "embudo":
        return await embudo(ctx, args as { dias?: number });
      case "rendimiento_del_equipo":
        return await rendimientoDelEquipo(ctx, args as { periodo?: Periodo; desde?: string; hasta?: string; asesor?: string });
      case "quien_esta_activo":
        return await quienEstaActivo(ctx);
      case "combi_del_dia":
        return await combiDelDia(ctx, args as { fecha?: string });
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
      default:
        return { datos: { error: `Herramienta desconocida: ${nombre}` } };
    }
  } catch (err) {
    console.error(`[assistant] tool ${nombre} failed:`, err);
    return { datos: { error: "Algo falló al consultar el CRM." } };
  }
}
