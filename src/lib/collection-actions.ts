// Gestiones de cobranza (tabla collection_actions, migración 082).

export type ActionChannel = "llamada" | "whatsapp" | "visita" | "correo" | "otro";
export type ActionResult =
  | "contactado"
  | "no_contesta"
  | "promesa"
  | "pago"
  | "rehusa"
  | "numero_errado"
  // Sin envío automático: solo dejan constancia (con la fecha de la fila).
  | "ultimatum"
  | "pase_legal";

export interface CollectionAction {
  id: string;
  contact_id: string;
  plan_id: string | null;
  channel: ActionChannel;
  result: ActionResult;
  promise_date: string | null;
  promise_amount: number | string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  author?: { full_name: string | null } | null;
}

export const CHANNELS: ReadonlyArray<{ key: ActionChannel; label: string }> = [
  { key: "llamada", label: "Llamada" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "visita", label: "Visita" },
  { key: "correo", label: "Correo" },
  { key: "otro", label: "Otro" },
];

export const RESULTS: ReadonlyArray<{ key: ActionResult; label: string }> = [
  { key: "contactado", label: "Contactado" },
  { key: "promesa", label: "Prometió pagar" },
  { key: "pago", label: "Dice que ya pagó" },
  { key: "no_contesta", label: "No contesta" },
  { key: "rehusa", label: "Se niega a pagar" },
  { key: "numero_errado", label: "Número errado" },
  { key: "ultimatum", label: "Ultimátum enviado" },
  { key: "pase_legal", label: "Pase a legal" },
];

export const resultLabel = (r: ActionResult) => RESULTS.find((x) => x.key === r)?.label ?? r;
export const channelLabel = (c: ActionChannel) => CHANNELS.find((x) => x.key === c)?.label ?? c;

/** Última gestión de cada contacto (las filas pueden venir en cualquier orden). */
export function latestByContact(actions: readonly CollectionAction[]): Map<string, CollectionAction> {
  const out = new Map<string, CollectionAction>();
  for (const a of actions) {
    const prev = out.get(a.contact_id);
    if (!prev || a.created_at > prev.created_at) out.set(a.contact_id, a);
  }
  return out;
}

export type PromiseState = "vigente" | "vencida" | null;

/**
 * Estado de la promesa de la última gestión. Solo se mira la última: si
 * después de prometer hubo otra gestión, esa manda. "vencida" = la fecha
 * prometida ya pasó y el cliente sigue en la lista de morosos.
 */
export function promiseState(latest: CollectionAction | undefined, today: string): PromiseState {
  if (!latest || latest.result !== "promesa" || !latest.promise_date) return null;
  return latest.promise_date < today ? "vencida" : "vigente";
}

export interface NewActionInput {
  channel: ActionChannel;
  result: ActionResult;
  promiseDate: string;
  promiseAmount: string;
  note: string;
}

/** Valida el formulario; devuelve el mensaje de error o null. */
export function validateAction(input: NewActionInput, today: string): string | null {
  if (input.result === "promesa") {
    if (!input.promiseDate) return "Pon la fecha en que prometió pagar.";
    if (input.promiseDate < today) return "La fecha de la promesa no puede ser pasada.";
  }
  if (input.promiseAmount) {
    const n = Number(input.promiseAmount);
    // numeric(12,2) en la base: hasta 9.999.999.999,99.
    if (!Number.isFinite(n) || n <= 0 || n >= MAX_AMOUNT) return "El monto prometido no es válido.";
  }
  if (input.note.length > 1000) return "La nota es muy larga (máximo 1000 caracteres).";
  return null;
}

const MAX_AMOUNT = 1e10;

/** Fila a insertar: fecha y monto prometidos solo si el resultado es promesa. */
export function actionPayload(input: NewActionInput) {
  const promesa = input.result === "promesa";
  return {
    channel: input.channel,
    result: input.result,
    promise_date: promesa && input.promiseDate ? input.promiseDate : null,
    promise_amount: promesa && input.promiseAmount ? Number(input.promiseAmount) : null,
    note: input.note.trim() || null,
  };
}

/** ¿El error de Supabase es "la tabla no existe" (migración sin aplicar)? */
export function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /does not exist|could not find the table/i.test(error.message ?? "");
}
