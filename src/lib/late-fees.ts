// Mora (recargo por atraso). Configurable por cuenta (migración 083):
// ninguna | fija (monto por cuota vencida) | porcentaje_mensual (sobre la
// cuota, proporcional a los días) | diaria (monto por día, por contrato, con
// tope de días), con días de gracia. Es informativa: se muestra en
// Cobranzas, no se suma sola a la deuda.

import { daysBetween, type OverdueInstallment } from "./collections";

export type LateFeeType = "ninguna" | "fija" | "porcentaje_mensual" | "diaria";

export interface LateFeeSettings {
  type: LateFeeType;
  value: number;
  graceDays: number;
  /** Tope de días cobrados por contrato (tipo diaria); 0 = sin tope. */
  capDays: number;
}

export const NO_LATE_FEE: LateFeeSettings = { type: "ninguna", value: 0, graceDays: 0, capDays: 0 };

const cents = (n: number) => Math.round(n * 100) / 100;

/** Saldo por cobrar de una cuota: `remaining` si viene, si no `amount`. */
const saldo = (r: OverdueInstallment) => Number(r.remaining ?? r.amount) || 0;

/** Mora de una cuota con `daysLate` días de atraso desde su vencimiento. */
export function lateFee(amount: number, daysLate: number, s: LateFeeSettings): number {
  if (s.type === "ninguna" || !(s.value > 0) || daysLate <= 0) return 0;
  if (daysLate <= Math.max(0, s.graceDays)) return 0;
  if (s.type === "diaria") return 0; // la diaria se calcula por contrato (contractLateFee)
  if (s.type === "fija") return cents(s.value);
  return cents(amount * (s.value / 100) * (daysLate / 30));
}

/**
 * Mora diaria de un contrato: valor × días cobrados, contando desde la cuota
 * vencida más antigua. Los días de gracia no se cobran y capDays (si > 0)
 * limita los días cobrados.
 */
export function contractLateFee(oldestOverdueDue: string | null, today: string, s: LateFeeSettings): number {
  if (s.type !== "diaria" || !(s.value > 0) || !oldestOverdueDue) return 0;
  const daysLate = daysBetween(oldestOverdueDue, today);
  const grace = Math.max(0, s.graceDays);
  if (daysLate <= grace) return 0;
  const charged = daysLate - grace;
  const days = s.capDays > 0 ? Math.min(charged, s.capDays) : charged;
  return cents(s.value * days);
}

/** Mora total por cliente y moneda (clave `contactId|moneda`). */
export function lateFeesByDebtor(
  rows: readonly OverdueInstallment[],
  today: string,
  s: LateFeeSettings,
): Map<string, number> {
  const out = new Map<string, number>();
  if (s.type === "ninguna") return out;
  const add = (key: string, fee: number) => {
    if (fee) out.set(key, cents((out.get(key) ?? 0) + fee));
  };
  const seen = new Set<string>();
  const oldestByPlan = new Map<string, { due: string; key: string }>();
  for (const r of rows) {
    const plan = r.plan;
    if (!plan || plan.status !== "activo" || !plan.contact || r.due_date >= today) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    // Voucher en revisión: el cliente ya pagó, no se le calcula mora.
    if (r.voucher_path) continue;
    const key = `${plan.contact.id}|${plan.currency || "PEN"}`;
    if (s.type === "diaria") {
      const cur = oldestByPlan.get(r.plan_id);
      if (!cur || r.due_date < cur.due) oldestByPlan.set(r.plan_id, { due: r.due_date, key });
      continue;
    }
    add(key, lateFee(saldo(r), daysBetween(r.due_date, today), s));
  }
  for (const { due, key } of oldestByPlan.values()) add(key, contractLateFee(due, today, s));
  return out;
}

/** Lee la configuración de mora desde la fila de la cuenta. */
export function settingsFromAccount(row: {
  late_fee_type?: string | null;
  late_fee_value?: number | string | null;
  late_fee_grace_days?: number | null;
  late_fee_cap_days?: number | null;
} | null | undefined): LateFeeSettings {
  const type = row?.late_fee_type;
  if (type !== "fija" && type !== "porcentaje_mensual" && type !== "diaria") return NO_LATE_FEE;
  return {
    type,
    value: Number(row?.late_fee_value) || 0,
    graceDays: Math.max(0, Number(row?.late_fee_grace_days) || 0),
    capDays: Math.max(0, Number(row?.late_fee_cap_days) || 0),
  };
}
