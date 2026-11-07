// Mora (recargo por atraso). Configurable por cuenta (migración 083):
// ninguna | fija (monto por cuota vencida) | porcentaje_mensual (sobre la
// cuota, proporcional a los días), con días de gracia. Es informativa: se
// muestra en Cobranzas, no se suma sola a la deuda.

import { daysBetween, type OverdueInstallment } from "./collections";

export type LateFeeType = "ninguna" | "fija" | "porcentaje_mensual";

export interface LateFeeSettings {
  type: LateFeeType;
  value: number;
  graceDays: number;
}

export const NO_LATE_FEE: LateFeeSettings = { type: "ninguna", value: 0, graceDays: 0 };

const cents = (n: number) => Math.round(n * 100) / 100;

/** Mora de una cuota con `daysLate` días de atraso desde su vencimiento. */
export function lateFee(amount: number, daysLate: number, s: LateFeeSettings): number {
  if (s.type === "ninguna" || !(s.value > 0) || daysLate <= 0) return 0;
  if (daysLate <= Math.max(0, s.graceDays)) return 0;
  if (s.type === "fija") return cents(s.value);
  return cents(amount * (s.value / 100) * (daysLate / 30));
}

/** Mora total por cliente y moneda (clave `contactId|moneda`). */
export function lateFeesByDebtor(
  rows: readonly OverdueInstallment[],
  today: string,
  s: LateFeeSettings,
): Map<string, number> {
  const out = new Map<string, number>();
  if (s.type === "ninguna") return out;
  const seen = new Set<string>();
  for (const r of rows) {
    const plan = r.plan;
    if (!plan || plan.status !== "activo" || !plan.contact || r.due_date >= today) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    // Voucher en revisión: el cliente ya pagó, no se le calcula mora.
    if (r.voucher_path) continue;
    const fee = lateFee(Number(r.amount) || 0, daysBetween(r.due_date, today), s);
    if (!fee) continue;
    const key = `${plan.contact.id}|${plan.currency || "PEN"}`;
    out.set(key, cents((out.get(key) ?? 0) + fee));
  }
  return out;
}

/** Lee la configuración de mora desde la fila de la cuenta. */
export function settingsFromAccount(row: {
  late_fee_type?: string | null;
  late_fee_value?: number | string | null;
  late_fee_grace_days?: number | null;
} | null | undefined): LateFeeSettings {
  const type = row?.late_fee_type;
  if (type !== "fija" && type !== "porcentaje_mensual") return NO_LATE_FEE;
  return {
    type,
    value: Number(row?.late_fee_value) || 0,
    graceDays: Math.max(0, Number(row?.late_fee_grace_days) || 0),
  };
}
