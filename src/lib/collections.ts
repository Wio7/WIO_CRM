// Cobranzas (ERP fase 1): bandeja de morosos de la oficina.
// Agrupa las cuotas pendientes y vencidas por cliente, calcula los días
// de atraso, el tramo (1-30, 31-60, 61-90, +90) y la deuda por proyecto
// y manzana. Puro: recibe filas ya leídas de Supabase y la fecha de hoy.

export interface OverdueInstallment {
  id: string;
  plan_id: string;
  number: number;
  amount: number | string;
  due_date: string; // YYYY-MM-DD
  plan: {
    id: string;
    currency: string;
    status: string;
    contact: { id: string; name: string | null; phone: string | null; dni?: string | null } | null;
    unit: {
      code: string;
      manzana: string | null;
      project: { name: string } | null;
    } | null;
  } | null;
}

export type Tramo = "1-30" | "31-60" | "61-90" | "90+";
export const TRAMOS: readonly Tramo[] = ["1-30", "31-60", "61-90", "90+"];

export interface Debtor {
  contactId: string;
  name: string;
  phone: string | null;
  dni: string | null;
  currency: string;
  /** Lotes con deuda, ej. "A-12, B-03". */
  units: string[];
  projects: string[];
  overdueCount: number;
  overdueAmount: number;
  oldestDue: string;
  daysLate: number;
  tramo: Tramo;
  /** Último aviso de cuota que se le mandó (ISO) o null. */
  lastReminder: string | null;
}

export interface GroupTotal {
  key: string; // "Proyecto · Mz A"
  project: string;
  manzana: string;
  currency: string;
  debtors: number;
  overdueAmount: number;
}

const DAY = 86_400_000;

/** Días entre dos fechas YYYY-MM-DD (hoy - vencimiento). */
export function daysBetween(due: string, today: string): number {
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / DAY);
}

export function tramoDe(days: number): Tramo {
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

/** Hoy en Lima, YYYY-MM-DD. */
export function hoyLima(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Arma la lista de morosos: una fila por cliente y moneda, solo con
 * cuotas vencidas (vencimiento antes de hoy) de planes activos. Ordenada
 * por días de atraso, luego por monto.
 */
export function buildDebtors(
  rows: readonly OverdueInstallment[],
  today: string,
  lastReminderByInstallment: ReadonlyMap<string, string> = new Map(),
): Debtor[] {
  const map = new Map<string, Debtor>();
  for (const r of rows) {
    const plan = r.plan;
    if (!plan || plan.status !== "activo" || !plan.contact) continue;
    if (r.due_date >= today) continue;
    const key = `${plan.contact.id}|${plan.currency}`;
    let d = map.get(key);
    if (!d) {
      d = {
        contactId: plan.contact.id,
        name: plan.contact.name?.trim() || plan.contact.phone || "Sin nombre",
        phone: plan.contact.phone,
        dni: plan.contact.dni ?? null,
        currency: plan.currency || "PEN",
        units: [],
        projects: [],
        overdueCount: 0,
        overdueAmount: 0,
        oldestDue: r.due_date,
        daysLate: 0,
        tramo: "1-30",
        lastReminder: null,
      };
      map.set(key, d);
    }
    d.overdueCount += 1;
    d.overdueAmount += Number(r.amount) || 0;
    if (r.due_date < d.oldestDue) d.oldestDue = r.due_date;
    const code = plan.unit?.code;
    if (code && !d.units.includes(code)) d.units.push(code);
    const project = plan.unit?.project?.name;
    if (project && !d.projects.includes(project)) d.projects.push(project);
    const sent = lastReminderByInstallment.get(r.id);
    if (sent && (!d.lastReminder || sent > d.lastReminder)) d.lastReminder = sent;
  }
  const out = [...map.values()];
  for (const d of out) {
    d.daysLate = daysBetween(d.oldestDue, today);
    d.tramo = tramoDe(d.daysLate);
    d.overdueAmount = Math.round(d.overdueAmount * 100) / 100;
  }
  return out.sort((a, b) => b.daysLate - a.daysLate || b.overdueAmount - a.overdueAmount);
}

/** Deuda vencida por proyecto y manzana (para ver dónde se concentra). */
export function groupByManzana(rows: readonly OverdueInstallment[], today: string): GroupTotal[] {
  const map = new Map<string, GroupTotal & { contacts: Set<string> }>();
  for (const r of rows) {
    const plan = r.plan;
    if (!plan || plan.status !== "activo" || !plan.contact || r.due_date >= today) continue;
    const project = plan.unit?.project?.name ?? "Sin proyecto";
    const manzana = plan.unit?.manzana ?? "—";
    const key = `${project} · Mz ${manzana}|${plan.currency}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key: `${project} · Mz ${manzana}`,
        project,
        manzana,
        currency: plan.currency || "PEN",
        debtors: 0,
        overdueAmount: 0,
        contacts: new Set(),
      };
      map.set(key, g);
    }
    g.contacts.add(plan.contact.id);
    g.overdueAmount += Number(r.amount) || 0;
  }
  return [...map.values()]
    .map(({ contacts, ...g }) => ({
      ...g,
      debtors: contacts.size,
      overdueAmount: Math.round(g.overdueAmount * 100) / 100,
    }))
    .sort((a, b) => b.overdueAmount - a.overdueAmount);
}

/** Enlace de WhatsApp con un mensaje de cobranza amable listo para enviar. */
export function whatsappLink(d: Debtor, monto: string): string | null {
  const digits = (d.phone ?? "").replace(/\D/g, "");
  if (digits.length < 9) return null;
  const phone = digits.length === 9 ? `51${digits}` : digits;
  const nombre = d.name.split(/\s+/)[0];
  const lotes = d.units.length ? ` del lote ${d.units.join(", ")}` : "";
  const cuotas = d.overdueCount === 1 ? "una cuota pendiente" : `${d.overdueCount} cuotas pendientes`;
  const text =
    `Hola ${nombre}, te saludamos de la oficina. Vemos ${cuotas}${lotes} por ${monto}. ` +
    `¿Nos confirmas cuándo puedes regularizar? Si ya pagaste, envíanos tu voucher por aquí. Gracias.`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

/** CSV (separado por punto y coma, para Excel en español). */
export function debtorsCsv(list: readonly Debtor[]): string {
  const esc = (v: string | number | null) => {
    const s = v == null ? "" : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["Cliente", "DNI", "Teléfono", "Proyecto", "Lotes", "Cuotas vencidas", "Monto vencido", "Moneda", "Vence desde", "Días de atraso", "Tramo", "Último aviso"];
  const lines = list.map((d) =>
    [d.name, d.dni, d.phone, d.projects.join(", "), d.units.join(", "), d.overdueCount, d.overdueAmount.toFixed(2), d.currency, d.oldestDue, d.daysLate, d.tramo, d.lastReminder?.slice(0, 10) ?? ""]
      .map(esc)
      .join(";"),
  );
  return [head.join(";"), ...lines].join("\n");
}
