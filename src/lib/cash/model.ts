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
