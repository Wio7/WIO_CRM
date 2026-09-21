// ============================================================
// Reservar una cita desde el servidor, sin un humano delante.
//
// Lo usa la IA que atiende los chats (058): el cliente dice cuándo puede,
// la IA propone una hora de la agenda real del equipo y aquí se guarda.
//
// Tres cosas que no se negocian, porque son las que separan agendar de
// prometer:
//
//   · La hora se vuelve a calcular AQUÍ. La que propuso el modelo es una
//     sugerencia, no una autorización: si entre que se le ofreció y ahora
//     alguien tomó ese hueco, se rechaza y se devuelven alternativas.
//   · La cita queda con un asesor concreto, y ESE asesor pasa a llevar la
//     conversación. Una cita sin dueño es una cita que nadie atiende.
//   · Al asesor le suena el celular. Enterarse al abrir la app no cuenta.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { diasLibres, equipoQuePuedeAgendar, PASO_MIN, type DiaLibre } from "./slots";
import { nombreDeCita } from "./tipos";
import { notifyConversation } from "@/lib/push/send";

export const TIPOS_DE_CITA = ["videollamada", "visita", "llamada"] as const;
export type TipoDeCita = (typeof TIPOS_DE_CITA)[number];

export const esTipoDeCita = (valor: unknown): valor is TipoDeCita =>
  typeof valor === "string" && (TIPOS_DE_CITA as readonly string[]).includes(valor);

/** La sala de la cita: del contacto, no del nombre, y siempre la misma. */
const salaDe = (contactId: string) => `golden-${contactId.replace(/-/g, "").slice(0, 18)}`;

/** "viernes 19 de septiembre, 10:30" en hora de Lima. */
export function enPalabras(iso: string): string {
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export type ResultadoReserva =
  | { ok: true; cita: { id: string; starts_at: string; kind: string; room: string | null }; asesorId: string }
  | { ok: false; motivo: "hora_ocupada" | "sin_agenda" | "error"; dias: DiaLibre[] };

/**
 * Reserva una cita para un contacto en la primera agenda libre a esa hora.
 *
 * @param cuandoIso instante propuesto; tiene que coincidir con un tramo
 *   libre de verdad, al milisegundo de como se ofreció.
 */
export async function reservarCita(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    conversationId: string;
    cuandoIso: string;
    tipo: TipoDeCita;
    notas?: string | null;
  },
): Promise<ResultadoReserva> {
  const { accountId, contactId, conversationId, cuandoIso, tipo } = args;

  const equipo = await equipoQuePuedeAgendar(db, accountId, contactId);
  if (!equipo.length) return { ok: false, motivo: "sin_agenda", dias: [] };

  const dias = await diasLibres(db, accountId, equipo);
  const pedido = Date.parse(cuandoIso);
  const tramo = Number.isNaN(pedido)
    ? undefined
    : dias.flatMap((d) => d.tramos).find((t) => Date.parse(t.starts_at) === pedido);

  if (!tramo) return { ok: false, motivo: "hora_ocupada", dias };

  const { data: cita, error } = await db
    .from("appointments")
    .insert({
      account_id: accountId,
      contact_id: contactId,
      user_id: tramo.user_id,
      starts_at: tramo.starts_at,
      minutes: PASO_MIN,
      kind: tipo,
      room: tipo === "videollamada" ? salaDe(contactId) : null,
      created_by: "ia",
      notes: args.notas || null,
    })
    .select("id, starts_at, kind, room")
    .single();

  if (error) {
    // 23505 es el índice único de la 049: alguien tomó esa hora en el
    // último segundo. Para el cliente es lo mismo que estar ocupada.
    const ocupada = (error as { code?: string }).code === "23505";
    if (!ocupada) console.error("[agenda] la IA no pudo reservar:", error.message);
    return { ok: false, motivo: ocupada ? "hora_ocupada" : "error", dias };
  }

  // La cita tiene dueño: que la conversación también. Sólo si no tenía
  // otro asesor ya encima — no se le quita un cliente a quien lo atiende.
  await db
    .from("conversations")
    .update({ assigned_agent_id: tramo.user_id })
    .eq("id", conversationId)
    .is("assigned_agent_id", null);

  const { data: contacto } = await db
    .from("contacts")
    .select("name, phone")
    .eq("id", contactId)
    .maybeSingle();

  await notifyConversation(db, {
    accountId,
    conversationId,
    assignedAgentId: tramo.user_id,
    title: "Nueva cita",
    body: `${contacto?.name || contacto?.phone || "Un cliente"}: ${nombreDeCita(tipo)} el ${enPalabras(cita.starts_at)}`,
  }).catch((err) => console.error("[agenda] aviso de cita falló:", err));

  return { ok: true, cita, asesorId: tramo.user_id };
}

/**
 * Las horas libres en texto, tal como se le pasan al modelo y tal como se
 * le pueden leer a un cliente. Se recorta a los primeros días con hueco:
 * una lista de dos semanas no ayuda a decidir, agobia.
 */
export function agendaEnTexto(dias: DiaLibre[], maxDias = 5, maxHoras = 6): string {
  return dias
    .slice(0, maxDias)
    .map((d) => {
      const horas = d.tramos.slice(0, maxHoras).map((t) => `${t.hora} (${t.starts_at})`);
      return `- ${d.etiqueta} (${d.fecha}): ${horas.join(", ")}`;
    })
    .join("\n");
}
