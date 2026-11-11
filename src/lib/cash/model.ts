import { esRubro, type Rubro } from './clasificar';

export type CashRole = 'owner' | 'cashier' | 'reader';
export interface CashCompany { id: string; name: string; role: CashRole }
export interface CashEntry {
  id: string;
  created_by?: string;
  kind: 'income' | 'expense';
  amount_cents: number;
  concept: string;
  counterparty: string;
  occurred_on: string;
  budget_id: string | null;
  reversal_of: string | null;
  reversed: boolean;
  /** 087: proyecto (real_estate_projects), gasto general y rubro. Nulos = sin asignar. */
  project_id?: string | null;
  project_general?: boolean;
  rubro?: Rubro | null;
  actor_name: string;
  created_at: string;
  updated_at?: string;
}
export interface CashAudit {
  id: number;
  entry_id: string;
  action: 'created' | 'edited' | 'reversed';
  actor_name: string;
  changed_at: string;
  reason: string | null;
  before_data: CashEntry | null;
  after_data: CashEntry;
}
export interface CashBudget {
  id: string;
  name: string;
  amount_cents: number;
  spent: number;
}
export interface CashSnapshot {
  accountId: string;
  companyId: string;
  accountName: string;
  role: CashRole;
  viewerId?: string;
  income: number;
  expense: number;
  entries: CashEntry[];
  entryCount: number;
  budgets: CashBudget[];
  members: { user_id: string; name: string; role: CashRole | 'none' }[];
  boxes?: { userId: string; name: string; income: number; expense: number; entryCount: number }[];
  audit?: CashAudit[];
}
/** Datos del formulario y del encabezado de una caja (cash_form_options, 087). */
export interface CashFormOptions {
  rubros: Rubro[];
  projects: { id: string; name: string }[];
  responsible: { userId: string; name: string } | null;
  canPanel: boolean;
  canSetResponsible: boolean;
  people: { userId: string; name: string }[];
}
export interface PanelRow { key?: string; id?: string | null; name?: string; rubro?: string; cents: number; count: number }
export interface CashPanel {
  month: string | null;
  companyId: string | null;
  totalCents: number;
  count: number;
  unassigned: { count: number; cents: number };
  byProject: (PanelRow & { key: string; name: string })[];
  byRubro: (PanelRow & { rubro: string })[];
  byCompany: (PanelRow & { id: string; name: string; responsible: string | null })[];
  byMonth: { month: string; cents: number }[];
  companies: { id: string; name: string; responsible: string | null }[];
  pending: {
    id: string; companyId: string; companyName: string; date: string; concept: string;
    counterparty: string; amountCents: number; rubro: Rubro | null; projectId: string | null; projectGeneral: boolean;
  }[];
}
export function money(cents: number) {
  return new Intl.NumberFormat('es-PE', {
    style: 'currency',
    currency: 'PEN',
  }).format(cents / 100);
}
/** Parse decimal input without binary floating point rounding or silent truncation. */
export function parseAmount(value: string): number {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(normalized))
    throw new Error('Escribe un monto válido con hasta dos decimales.');
  const [whole, fraction = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents < 1 || cents > 99999999999)
    throw new Error('El monto debe ser mayor que cero y menor a mil millones.');
  return cents;
}
export function limaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  return ['year', 'month', 'day']
    .map((t) => parts.find((p) => p.type === t)?.value)
    .join('-');
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateCommand(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('Operación no válida.');
  const c = body as Record<string, unknown>;
  const text = (key: string, min: number, max: number) => {
    if (
      typeof c[key] !== 'string' ||
      (c[key] as string).trim().length < min ||
      (c[key] as string).trim().length > max
    )
      throw new Error(`Revisa el campo ${key}.`);
  };
  const id = (key: string) => {
    if (typeof c[key] !== 'string' || !uuid.test(c[key] as string))
      throw new Error('Identificador no válido.');
  };
  if (c.action === 'company') {
    id('requestId');
    text('name', 1, 100);
    return c;
  }
  id('companyId');
  if (c.action === 'member') {
    id('userId');
    if (!['none', 'reader', 'cashier'].includes(String(c.role)))
      throw new Error('Permiso no válido.');
    return c;
  }
  id('requestId');
  if (c.action === 'reverse') {
    id('entryId');
    text('reason', 3, 180);
    return c;
  }
  if (c.action === 'edit') {
    id('entryId');
    text('reason', 3, 180);
    text('expectedUpdatedAt', 1, 80);
  }
  if (
    !Number.isSafeInteger(c.amountCents) ||
    Number(c.amountCents) < 1 ||
    Number(c.amountCents) > 99999999999
  )
    throw new Error('Monto no válido.');
  if (c.action === 'budget') {
    text('name', 1, 100);
    return c;
  }
  if (!['entry', 'edit'].includes(String(c.action)) ||
      (c.action === 'entry' && !['income', 'expense'].includes(String(c.kind))))
    throw new Error('Operación no válida.');
  text('concept', 1, 200);
  text('counterparty', 1, 160);
  // Un gasto nuevo desde la app lleva rubro y proyecto (o gasto general).
  // WhatsApp los deja opcionales y no pasa por aquí; editar no los pide.
  if (c.action === 'entry' && c.kind === 'expense') {
    if (!esRubro(c.rubro)) throw new Error('Elige el rubro del gasto.');
    if (c.projectGeneral !== undefined && typeof c.projectGeneral !== 'boolean')
      throw new Error('Gasto general no válido.');
    if ((c.projectGeneral === true) === Boolean(c.projectId))
      throw new Error('Elige el proyecto del gasto, o márcalo como gasto general.');
    if (c.projectId) id('projectId');
  }
  if (
    typeof c.date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(c.date) ||
    c.date < '2000-01-01' ||
    c.date > limaDate()
  )
    throw new Error('Fecha no válida.');
  const parsed = new Date(`${c.date}T12:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== c.date
  )
    throw new Error('Fecha no válida.');
  if (c.budgetId) {
    id('budgetId');
    if (c.kind !== 'expense')
      throw new Error('Solo los gastos se asignan a presupuestos.');
  }
  return c;
}
