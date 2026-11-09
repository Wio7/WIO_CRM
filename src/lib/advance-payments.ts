// Pago por adelantado: valida qué cuotas futuras se pueden adelantar.
// Solo se aceptan "las siguientes" (las primeras k pendientes futuras, sin
// saltos) o "las últimas" (las últimas k por número). Nunca una vencida.

export interface PendingInstallment {
  id: string;
  number: number;
  due_date: string; // YYYY-MM-DD
}

export type AdvanceResult =
  | { ok: true; mode: "siguientes" | "ultimas" }
  | { ok: false; error: string };

export function validateAdvance(
  pending: readonly PendingInstallment[],
  selected: readonly string[],
  today: string,
): AdvanceResult {
  const ids = new Set(selected);
  if (ids.size === 0) return { ok: false, error: "Elige al menos una cuota para adelantar." };
  const byId = new Map(pending.map((p) => [p.id, p]));
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) return { ok: false, error: "Una de las cuotas elegidas no está pendiente." };
    if (p.due_date < today) {
      return { ok: false, error: `La cuota ${p.number} ya venció: se paga como deuda, no como adelanto.` };
    }
  }
  const future = pending.filter((p) => p.due_date >= today).sort((a, b) => a.number - b.number);
  const k = ids.size;
  if (future.slice(0, k).every((p) => ids.has(p.id))) return { ok: true, mode: "siguientes" };
  if (future.slice(future.length - k).every((p) => ids.has(p.id))) return { ok: true, mode: "ultimas" };
  return {
    ok: false,
    error: "Solo se puede adelantar las siguientes cuotas en orden o las últimas, sin saltear ninguna.",
  };
}
