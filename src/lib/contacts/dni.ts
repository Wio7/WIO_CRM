// ============================================================
// The contact's DNI (migration 044) in the contact forms.
//
// Half of how a client signs into the Golden App (phone + DNI), so the
// forms only send it when the advisor actually changed it: changing it
// signs the client out of the app (migration 045), and a deployment
// without 044 must keep saving contacts as before.
// Browser-safe on purpose — no node:crypto here.
// ============================================================

/** Digits only, 8 to 12, or null. Dots, dashes and spaces are dropped. */
export function cleanDni(input: string): string | null {
  const raw = input.trim();
  if (/[^0-9\s.-]/.test(raw)) return null;
  const digits = raw.replace(/\D/g, "");
  return /^[0-9]{8,12}$/.test(digits) ? digits : null;
}

/**
 * The `dni` part of an update: `{}` when unchanged, `{ dni }` when set or
 * cleared, or an error message the form shows as-is.
 */
export function dniChange(
  original: string | null | undefined,
  typed: string,
): { patch: { dni?: string | null } } | { error: string } {
  const empty = typed.trim() === "";
  const next = empty ? null : cleanDni(typed);
  if (!empty && !next) {
    return { error: "El DNI son 8 dígitos (el carné de extranjería, hasta 12). Sólo números." };
  }
  return next === (original ?? null) ? { patch: {} } : { patch: { dni: next } };
}

/** Database errors about the DNI, in words, or null if it's another error. */
export function dniErrorMessage(error: unknown): string | null {
  const e = (error ?? {}) as { code?: string; message?: string };
  const text = e.message ?? "";
  if (e.code === "23505" && /dni/i.test(text)) {
    return "Ese DNI ya está registrado en otro contacto de la cuenta.";
  }
  if ((e.code === "PGRST204" || e.code === "42703") && /dni/i.test(text)) {
    return "El CRM todavía no guarda DNI: falta aplicar la migración 044 en Supabase.";
  }
  if (e.code === "23514" && /dni/i.test(text)) {
    return "El DNI son 8 dígitos (el carné de extranjería, hasta 12). Sólo números.";
  }
  return null;
}
