// ============================================================
// Referidos y cupones (051).
//
// Un cliente comparte su enlace; quien entra a la app con él queda como
// su referido. Cuando el referido compra (le crean su plan), la base lo
// marca 'compro' y el equipo decide el premio: un cupón de un solo uso
// atado al DNI de quien lo trajo.
// ============================================================

import { randomInt } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Sin O/0, I/1, L: se dicta por teléfono sin confusiones. */
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function codigoAleatorio(largo = 6): string {
  let c = "";
  for (let i = 0; i < largo; i += 1) c += ALFABETO[randomInt(ALFABETO.length)];
  return c;
}

/** Normaliza lo que escriben: mayúsculas, sin espacios ni guiones. */
export function limpiarCodigo(texto: string): string {
  return String(texto ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

/** El código de referido de un contacto; lo crea la primera vez. */
export async function codigoDeReferido(
  db: SupabaseClient,
  contacto: { id: string; account_id: string },
): Promise<string | null> {
  const { data, error } = await db
    .from("contacts")
    .select("referral_code")
    .eq("id", contacto.id)
    .maybeSingle();
  if (error) return null; // sin la 051
  if (data?.referral_code) return data.referral_code as string;

  for (let intento = 0; intento < 5; intento += 1) {
    const codigo = codigoAleatorio(6);
    const { error: e } = await db
      .from("contacts")
      .update({ referral_code: codigo })
      .eq("id", contacto.id)
      .is("referral_code", null);
    if (!e) {
      const { data: d2 } = await db.from("contacts").select("referral_code").eq("id", contacto.id).maybeSingle();
      return (d2?.referral_code as string) ?? codigo;
    }
    // 23505: el código ya lo tiene otro. Se prueba otro.
    if ((e as { code?: string }).code !== "23505") return null;
  }
  return null;
}

/**
 * Anota que `referido` llegó con el código `codigo`. No hace nada si el
 * código no existe, es el suyo propio o el referido ya tenía padrino.
 */
export async function anotarReferido(
  db: SupabaseClient,
  referido: { id: string; account_id: string },
  codigo: string,
): Promise<void> {
  const limpio = limpiarCodigo(codigo);
  if (!limpio) return;
  const { data: padrino } = await db
    .from("contacts")
    .select("id")
    .eq("account_id", referido.account_id)
    .eq("referral_code", limpio)
    .maybeSingle();
  if (!padrino || padrino.id === referido.id) return;
  const { error } = await db.from("referrals").insert({
    account_id: referido.account_id,
    referrer_contact_id: padrino.id,
    referred_contact_id: referido.id,
  });
  if (error && (error as { code?: string }).code !== "23505") {
    console.error("[referrals] could not record the referral:", error.message);
  }
}
