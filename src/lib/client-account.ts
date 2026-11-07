// "Cuenta del cliente": todo lo que un contacto debe y pagó, de la
// separación a la última cuota (núcleo del ERP, ficha única del cliente).
// Lee las filas de la vista payment_plan_balances (migración 043).

export interface PlanBalanceRow {
  plan_id: string;
  currency: string;
  total_amount: number | string;
  down_payment: number | string;
  status: string;
  paid_amount: number | string;
  paid_count: number;
  pending_amount: number | string;
  pending_count: number;
  overdue_count: number;
  overdue_amount: number | string;
  next_due_date: string | null;
}

export interface CurrencyTotals {
  currency: string;
  /** Precio total de los planes (incluye la cuota inicial). */
  total: number;
  /** Cuota inicial + cuotas pagadas. */
  paid: number;
  /** Cuotas pendientes (vencidas y por vencer). */
  pending: number;
  overdue: number;
  overdueCount: number;
  /** Próxima fecha de pago pendiente (YYYY-MM-DD) o null. */
  nextDue: string | null;
  activePlans: number;
}

const n = (v: number | string | null | undefined) => Number(v) || 0;

/** Planes que todavía cuentan para la deuda del cliente. */
const COUNTS = new Set(["activo", "pagado", "suspendido"]);

/**
 * Suma los planes de un cliente por moneda (no se mezclan soles y dólares).
 * Los planes cancelados no cuentan. El orden sigue al de la primera
 * aparición de cada moneda.
 */
export function summarizeClientAccount(rows: readonly PlanBalanceRow[]): CurrencyTotals[] {
  const byCurrency = new Map<string, CurrencyTotals>();
  for (const r of rows) {
    if (!COUNTS.has(r.status)) continue;
    const cur = r.currency || "PEN";
    let t = byCurrency.get(cur);
    if (!t) {
      t = {
        currency: cur,
        total: 0,
        paid: 0,
        pending: 0,
        overdue: 0,
        overdueCount: 0,
        nextDue: null,
        activePlans: 0,
      };
      byCurrency.set(cur, t);
    }
    t.total += n(r.total_amount);
    t.paid += n(r.down_payment) + n(r.paid_amount);
    t.pending += n(r.pending_amount);
    t.overdue += n(r.overdue_amount);
    t.overdueCount += r.overdue_count || 0;
    if (r.status === "activo") t.activePlans += 1;
    if (r.next_due_date && (!t.nextDue || r.next_due_date < t.nextDue)) {
      t.nextDue = r.next_due_date;
    }
  }
  return [...byCurrency.values()];
}

/** Estado corto de un plan para la ficha. */
export function planHealth(r: PlanBalanceRow): "al-dia" | "con-atraso" | "pagado" | "cancelado" | "otro" {
  if (r.status === "pagado" || (r.status === "activo" && r.pending_count === 0)) return "pagado";
  if (r.status === "cancelado") return "cancelado";
  if (r.status !== "activo") return "otro";
  return r.overdue_count > 0 ? "con-atraso" : "al-dia";
}
