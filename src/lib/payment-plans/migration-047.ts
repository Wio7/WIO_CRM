// ============================================================
// Working before migration 047 has been run.
//
// 047 adds the payment detail to `installments` (how they paid, the
// operation number, the voucher). Code ships before migrations are run —
// it happened with 042 and again with 046 — and when it does, the whole
// screen must not die over a column that isn't there yet: registering a
// payment still has to work, and the client still has to see the
// instalments they owe.
//
// So both callers ask for the full shape first and, only if Postgres
// says the column doesn't exist, ask again for what 043 already had.
// Once 047 is applied the second attempt never runs again.
// ============================================================

/** Columns 047 adds. The retry drops exactly these. */
export const COLUMNAS_047 = [
  "paid_method",
  "paid_reference",
  "voucher_path",
  "notes",
  "registered_by",
] as const;

/**
 * True when the error is Postgres (42703) or PostgREST (PGRST204)
 * complaining about one of 047's columns — i.e. the migration is
 * pending. Any other error is a real error and must surface.
 */
export function falta047(error: unknown): boolean {
  const e = (error ?? {}) as { code?: string; message?: string };
  if (e.code !== "42703" && e.code !== "PGRST204") return false;
  const texto = e.message ?? "";
  return COLUMNAS_047.some((c) => texto.includes(c));
}
