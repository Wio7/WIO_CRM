// ============================================================
// Etapas del cliente (migración 100): Nuevo → Contestó → En seguimiento →
// Agendó visita → Visitó → Separó/compró, y Perdido.
//
// Nuevo, Contestó, Agendó y Visitó las pone la base sola (disparadores).
// Desde aquí se mueven las que dependen de la conversación: la IA marca
// seguimiento o perdido, y el asistente del equipo mueve cualquiera.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export const CLAVES_DE_ETAPA = ["nuevo", "contesto", "seguimiento", "agendo", "visito", "compro", "perdido"] as const;
export type ClaveDeEtapa = (typeof CLAVES_DE_ETAPA)[number];

/** Cómo se dice cada etapa (los nombres de Broker Home en la 100). */
export const NOMBRE_DE_ETAPA: Record<ClaveDeEtapa, string> = {
  nuevo: "Nuevo",
  contesto: "Contestó",
  seguimiento: "En seguimiento",
  agendo: "Agendó visita",
  visito: "Visitó",
  compro: "Separó / compró",
  perdido: "Perdido",
};

const SINONIMOS: Record<string, ClaveDeEtapa> = {
  nuevo: "nuevo",
  contesto: "contesto",
  respondio: "contesto",
  seguimiento: "seguimiento",
  interesado: "seguimiento",
  agendo: "agendo",
  agendado: "agendo",
  cita: "agendo",
  visito: "visito",
  visitado: "visito",
  compro: "compro",
  separo: "compro",
  vendido: "compro",
  ganado: "compro",
  perdido: "perdido",
  descartado: "perdido",
  "no le interesa": "perdido",
};

/** "Agendó visita", "separó", "compró" → clave. null si no se entiende. */
export function claveDeEtapa(texto: string | null | undefined): ClaveDeEtapa | null {
  const t = String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
  if (!t) return null;
  if (SINONIMOS[t]) return SINONIMOS[t];
  for (const [palabra, clave] of Object.entries(SINONIMOS)) {
    if (t.includes(palabra)) return clave;
  }
  return null;
}

/** ¿La cuenta usa etapas con clave? (si no, no se le enseña el sello a la IA). */
export async function cuentaConEtapas(db: SupabaseClient, accountId: string): Promise<boolean> {
  // Nunca puede tumbar la respuesta al cliente: ante cualquier fallo, sin etapas.
  try {
    const { data, error } = await db
      .from("pipeline_stages")
      .select("id, pipelines!inner(account_id)")
      .eq("pipelines.account_id", accountId)
      .not("clave", "is", null)
      .limit(1);
    // Sin la 100 la columna no existe: simplemente no hay etapas.
    if (error) return false;
    return (data ?? []).length > 0;
  } catch {
    return false;
  }
}

/** Mueve al cliente. Devuelve la clave en la que quedó, o null. Nunca lanza. */
export async function moverEtapa(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; conversationId?: string | null; clave: ClaveDeEtapa; forzar?: boolean },
): Promise<string | null> {
  try {
    const { data, error } = await db.rpc("mover_etapa_cliente", {
      p_account: args.accountId,
      p_contact: args.contactId,
      p_conversation: args.conversationId ?? null,
      p_clave: args.clave,
      p_forzar: Boolean(args.forzar),
    });
    if (error) {
      console.error("[etapas] no se pudo mover:", error.message);
      return null;
    }
    return (data as string | null) ?? null;
  } catch (err) {
    console.error("[etapas] no se pudo mover:", err);
    return null;
  }
}
