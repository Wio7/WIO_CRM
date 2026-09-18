// ============================================================
// Canales: por dónde llegó un mensaje y por dónde se contesta.
//
// La migración 050 añade `messages.channel` y `conversations.channel`.
// Hasta que alguien la corra, esas columnas no existen y escribirlas
// tumba el INSERT entero. Por eso todo lo que escribe un canal pasa por
// aquí: se intenta con la columna y, si la base no la conoce, se repite
// sin ella. Un mensaje sin canal es mejor que un mensaje perdido.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export type Canal = "whatsapp" | "app" | "messenger" | "instagram" | "correo";

/** La columna no existe todavía (050 sin aplicar). */
export function faltaColumnaCanal(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    /channel/i.test(error.message ?? "")
  );
}

/**
 * Inserta un mensaje con su canal. Devuelve lo mismo que un
 * `insert(...).select(columnas).single()` de supabase-js.
 */
export async function insertarMensaje<T = Record<string, unknown>>(
  db: SupabaseClient,
  fila: Record<string, unknown> & { channel?: Canal },
  columnas = "*",
): Promise<{ data: T | null; error: { code?: string; message: string } | null }> {
  const primero = await db.from("messages").insert(fila).select(columnas).single();
  if (!primero.error || !fila.channel || !faltaColumnaCanal(primero.error)) {
    return primero as { data: T | null; error: { code?: string; message: string } | null };
  }
  const sinCanal = { ...fila };
  delete sinCanal.channel;
  const segundo = await db.from("messages").insert(sinCanal).select(columnas).single();
  return segundo as { data: T | null; error: { code?: string; message: string } | null };
}

/**
 * Actualiza la conversación y, si se pasa, el canal por el que escribió
 * el cliente. Si la columna no existe, actualiza el resto igual.
 */
export async function actualizarConversacion(
  db: SupabaseClient,
  conversationId: string,
  cambios: Record<string, unknown>,
  canal?: Canal,
): Promise<void> {
  const conCanal = canal ? { ...cambios, channel: canal } : cambios;
  const { error } = await db.from("conversations").update(conCanal).eq("id", conversationId);
  if (!error) return;
  if (canal && faltaColumnaCanal(error)) {
    const { error: otra } = await db.from("conversations").update(cambios).eq("id", conversationId);
    if (otra) console.error("[channels] conversation update failed:", otra.message);
    return;
  }
  console.error("[channels] conversation update failed:", error.message);
}

/** El canal de una conversación ya leída (`select('*')`). WhatsApp si no dice. */
export function canalDe(conv: { channel?: string | null } | null | undefined): Canal {
  const c = conv?.channel;
  return c === "app" || c === "messenger" || c === "instagram" || c === "correo" ? c : "whatsapp";
}
