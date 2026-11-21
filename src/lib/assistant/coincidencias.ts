// ============================================================
// Piezas pequeñas del asistente que deciden algo importante y por eso
// tienen prueba: la hora de una cita, a quién se refiere un nombre y
// cuánto debe un cliente con varios planes.
// ============================================================

/**
 * Fecha y hora de una cita. Si el modelo la manda sin zona, es hora de Lima
 * (UTC-5, sin horario de verano); en un servidor en UTC, `Date.parse` la
 * tomaría como UTC y la cita quedaría 5 horas antes.
 */
export function fechaLima(texto: string): number {
  const t = String(texto ?? "").trim().replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t)) return Number.NaN;
  const conZona = /(Z|[+-]\d{2}:?\d{2})$/i.test(t);
  const completa = /T\d{2}:\d{2}$/.test(t) ? `${t}:00` : t;
  return Date.parse(conZona ? completa : `${completa}-05:00`);
}

const plano = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * ¿El nombre buscado es esta persona? Cada palabra buscada tiene que ser el
 * comienzo de una palabra del nombre: "ana" es "Ana Torres" pero no "Mariana".
 */
export function nombreCoincide(nombre: string | null | undefined, buscado: string): boolean {
  const palabras = plano(nombre ?? "").split(" ");
  const pedidas = plano(buscado).split(" ").filter(Boolean);
  return pedidas.length > 0 && pedidas.every((q) => palabras.some((w) => w.startsWith(q)));
}

export interface FilaSaldo {
  currency: string | null;
  pending_amount: number | string | null;
  overdue_amount?: number | string | null;
  overdue_count: number | string | null;
  next_due_date: string | null;
}

/** Todos los planes de un cliente (dos lotes = dos planes), por moneda. */
export function sumarSaldos(filas: FilaSaldo[]) {
  const porMoneda = new Map<string, { moneda: string; pendiente: number; atrasado: number }>();
  let atrasadas = 0;
  let proximo: string | null = null;
  for (const f of filas) {
    const moneda = f.currency || "PEN";
    const m = porMoneda.get(moneda) ?? { moneda, pendiente: 0, atrasado: 0 };
    m.pendiente += Number(f.pending_amount) || 0;
    m.atrasado += Number(f.overdue_amount) || 0;
    porMoneda.set(moneda, m);
    atrasadas += Number(f.overdue_count) || 0;
    if (f.next_due_date && (!proximo || f.next_due_date < proximo)) proximo = f.next_due_date;
  }
  return { planes: filas.length, atrasadas, por_moneda: [...porMoneda.values()], proximo_vencimiento: proximo };
}
