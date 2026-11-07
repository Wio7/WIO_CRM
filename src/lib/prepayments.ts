// Abono a capital (migración 083). Calcula los montos nuevos de las cuotas
// futuras; la base (RPC apply_prepayment) vuelve a validar y aplica todo
// en una transacción. Todo se hace en céntimos enteros.

export type PrepaymentMode = "reducir_plazo" | "reducir_cuota";

export interface PendingInstallment {
  id: string;
  number: number;
  amount: number | string;
  due_date: string; // YYYY-MM-DD
  /** Voucher subido por el cliente y aún sin aprobar (047). */
  voucher_path?: string | null;
}

export interface InstallmentChange {
  id: string;
  newAmount: number;
  status: "pendiente" | "adelantada";
}

export interface PrepaymentPlan {
  changes: InstallmentChange[] | null;
  error: string | null;
  /** Cuotas vencidas que el abono no toca (se pagan primero). */
  overdueSkipped: number;
  /** Cuotas con voucher en revisión que el abono no toca (evita pagar dos veces). */
  inReviewSkipped: number;
  /** Suma de las cuotas futuras que se pueden abonar. */
  available: number;
}

const toCents = (v: number | string) => Math.round((Number(v) || 0) * 100);

export function planPrepayment(
  pending: readonly PendingInstallment[],
  amount: number,
  mode: PrepaymentMode,
  today: string,
): PrepaymentPlan {
  const notOverdue = pending.filter((p) => p.due_date >= today);
  const overdueSkipped = pending.length - notOverdue.length;
  const future = notOverdue.filter((p) => !p.voucher_path).sort((a, b) => a.number - b.number);
  const inReviewSkipped = notOverdue.length - future.length;
  const availableCents = future.reduce((s, p) => s + toCents(p.amount), 0);
  const base = { overdueSkipped, inReviewSkipped, available: availableCents / 100 };

  if (!(amount > 0) || !Number.isFinite(amount)) return { ...base, changes: null, error: "El abono debe ser mayor a cero." };
  if (future.length === 0) return { ...base, changes: null, error: "No hay cuotas futuras pendientes para abonar." };
  const target = Math.round(amount * 100);
  if (target > availableCents) {
    return { ...base, changes: null, error: `El abono supera lo que falta por vencer (${(availableCents / 100).toFixed(2)}).` };
  }

  const take = new Map<string, number>();
  if (mode === "reducir_plazo") {
    let rest = target;
    for (let i = future.length - 1; i >= 0 && rest > 0; i--) {
      const t = Math.min(rest, toCents(future[i].amount));
      take.set(future[i].id, t);
      rest -= t;
    }
  } else {
    // Reparto parejo; las cuotas más chicas primero para que ninguna baje
    // de cero y lo que no cabe pase a las demás.
    const asc = [...future].sort((a, b) => toCents(a.amount) - toCents(b.amount) || a.number - b.number);
    let rest = target;
    for (let i = 0; i < asc.length; i++) {
      const left = asc.length - i;
      const share = i === asc.length - 1 ? rest : Math.floor(rest / left);
      const t = Math.min(share, toCents(asc[i].amount));
      if (t > 0) take.set(asc[i].id, t);
      rest -= t;
    }
    if (rest !== 0) return { ...base, changes: null, error: "No se pudo repartir el abono; revisa los montos." };
  }

  const order = mode === "reducir_plazo" ? [...future].reverse() : future;
  const changes: InstallmentChange[] = [];
  for (const p of order) {
    const t = take.get(p.id);
    if (!t) continue;
    const left = toCents(p.amount) - t;
    changes.push({ id: p.id, newAmount: left / 100, status: left === 0 ? "adelantada" : "pendiente" });
  }
  return { ...base, changes, error: null };
}
