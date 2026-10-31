/**
 * In-memory stand-in for the slice of the Supabase query builder the
 * broadcast code uses. Test-only (no network).
 *
 * It deliberately mimics the two PostgREST behaviours that bit this
 * feature in production:
 *   - a response never holds more than `maxRows` rows (default 1000),
 *     however many were asked for;
 *   - an UPDATE ... WHERE is atomic, so compare-and-swap claims work.
 * It also imitates the DB triggers the dispatcher leans on: every
 * UPDATE of `broadcasts` stamps `updated_at`, and a recipient status
 * change stamps its parent broadcast's `updated_at` (migration 005).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;
type Op = 'select' | 'insert' | 'update' | 'delete';

interface Filter {
  kind: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notin';
  col: string;
  value: unknown;
}

export interface QueryLog {
  table: string;
  op: Op;
  filters: Filter[];
  payload?: unknown;
  rows: number;
}

interface Failure {
  table: string;
  op: Op;
  error: { message: string; code?: string };
  times: number;
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  maxRows = 1000;
  now: () => number = Date.now;
  log: QueryLog[] = [];
  failures: Failure[] = [];
  /** Runs right before every query executes (for race simulations). */
  beforeExec?: (q: { table: string; op: Op; filters: Filter[] }) => void;
  private seq = 0;

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [name, rows] of Object.entries(seed)) {
      this.tables[name] = rows.map((r) => ({ ...r }));
    }
  }

  table(name: string): Row[] {
    return (this.tables[name] ??= []);
  }

  nextId(prefix: string): string {
    return `${prefix}-${String(++this.seq).padStart(6, '0')}`;
  }

  failNext(table: string, op: Op, error: Failure['error'], times = 1) {
    this.failures.push({ table, op, error, times });
  }

  from(table: string) {
    return new FakeQuery(this, table);
  }

  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }

  /** Sizes of every `.in(...)` list used so far. */
  inListSizes(): number[] {
    return this.log.flatMap((l) =>
      l.filters.filter((f) => f.kind === 'in').map((f) => (f.value as unknown[]).length),
    );
  }
}

function digitsOf(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '');
}

function column(row: Row, col: string): unknown {
  if (col.includes('->>')) {
    const [base, key] = col.split('->>');
    const obj = row[base] as Record<string, unknown> | null | undefined;
    const v = obj?.[key];
    return v === undefined || v === null ? null : String(v);
  }
  return row[col];
}

function matches(row: Row, f: Filter): boolean {
  const v = column(row, f.col);
  switch (f.kind) {
    case 'eq':
      return v === f.value;
    case 'neq':
      return v !== f.value;
    case 'gt':
      return v != null && (v as string) > (f.value as string);
    case 'gte':
      return v != null && (v as string) >= (f.value as string);
    case 'lt':
      return v != null && (v as string) < (f.value as string);
    case 'lte':
      return v != null && (v as string) <= (f.value as string);
    case 'in':
      return (f.value as unknown[]).includes(v);
    case 'notin':
      return !(f.value as unknown[]).includes(v);
  }
}

class FakeQuery implements PromiseLike<unknown> {
  private op: Op = 'select';
  private filters: Filter[] = [];
  private payload: unknown;
  private orders: { col: string; asc: boolean }[] = [];
  private from_ = 0;
  private to_: number | null = null;
  private limit_: number | null = null;
  private returning = false;
  private mode: 'many' | 'single' | 'maybe' = 'many';
  private head = false;
  private wantCount = false;

  constructor(
    private db: FakeDb,
    private table: string,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === 'select') {
      this.head = Boolean(opts?.head);
      this.wantCount = Boolean(opts?.count);
    }
    this.returning = true;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = 'insert';
    this.payload = rows;
    return this;
  }
  update(values: Row) {
    this.op = 'update';
    this.payload = values;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  eq(col: string, value: unknown) {
    this.filters.push({ kind: 'eq', col, value });
    return this;
  }
  neq(col: string, value: unknown) {
    this.filters.push({ kind: 'neq', col, value });
    return this;
  }
  gt(col: string, value: unknown) {
    this.filters.push({ kind: 'gt', col, value });
    return this;
  }
  gte(col: string, value: unknown) {
    this.filters.push({ kind: 'gte', col, value });
    return this;
  }
  lt(col: string, value: unknown) {
    this.filters.push({ kind: 'lt', col, value });
    return this;
  }
  lte(col: string, value: unknown) {
    this.filters.push({ kind: 'lte', col, value });
    return this;
  }
  in(col: string, value: unknown[]) {
    this.filters.push({ kind: 'in', col, value });
    return this;
  }
  /** Only `.not(col, 'in', '(a,b)')` is supported. */
  not(col: string, op: string, value: string) {
    if (op !== 'in') throw new Error(`fake-db: not(${op}) unsupported`);
    const list = value.replace(/^\(|\)$/g, '').split(',');
    this.filters.push({ kind: 'notin', col, value: list });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push({ col, asc: opts?.ascending !== false });
    return this;
  }
  range(from: number, to: number) {
    this.from_ = from;
    this.to_ = to;
    return this;
  }
  limit(n: number) {
    this.limit_ = n;
    return this;
  }
  single() {
    this.mode = 'single';
    return this;
  }
  maybeSingle() {
    this.mode = 'maybe';
    return this;
  }

  then<R1 = unknown, R2 = never>(
    onfulfilled?: ((value: unknown) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return Promise.resolve().then(() => this.exec()).then(onfulfilled, onrejected);
  }

  private result(rows: Row[], count?: number) {
    const copy = rows.map((r) => ({ ...r }));
    if (this.mode === 'single') {
      return copy.length === 1
        ? { data: copy[0], error: null }
        : { data: null, error: { message: `expected 1 row, got ${copy.length}`, code: 'PGRST116' } };
    }
    if (this.mode === 'maybe') {
      if (copy.length > 1) return { data: null, error: { message: 'multiple rows' } };
      return { data: copy[0] ?? null, error: null };
    }
    return { data: this.head ? null : copy, error: null, count: count ?? copy.length };
  }

  private exec() {
    const db = this.db;
    db.beforeExec?.({ table: this.table, op: this.op, filters: this.filters });

    const failure = db.failures.find(
      (f) => f.table === this.table && f.op === this.op && f.times > 0,
    );
    if (failure) {
      failure.times--;
      db.log.push({ table: this.table, op: this.op, filters: this.filters, rows: 0 });
      return { data: null, error: failure.error };
    }

    const all = db.table(this.table);
    const entry: QueryLog = {
      table: this.table,
      op: this.op,
      filters: this.filters,
      payload: this.payload,
      rows: 0,
    };
    db.log.push(entry);

    if (this.op === 'insert') {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      if (this.table === 'contacts') {
        // UNIQUE (account_id, phone_normalized), migration 022. The whole
        // statement is atomic: one clash and nothing is inserted.
        const seen = new Set(all.map((c) => c.account_id + '|' + c.phone_normalized));
        for (const r of rows) {
          const key = r.account_id + '|' + digitsOf(r.phone);
          if (seen.has(key)) {
            return { data: null, error: { message: 'duplicate key value', code: '23505' } };
          }
          seen.add(key);
        }
      }
      const inserted = rows.map((r) => {
        const row: Row = { ...r };
        if (this.table === 'contacts') row.phone_normalized = digitsOf(r.phone);
        if (row.id === undefined) row.id = db.nextId(this.table);
        if (this.table === 'broadcasts' && row.updated_at === undefined) {
          row.updated_at = new Date(db.now()).toISOString();
        }
        all.push(row);
        return row;
      });
      entry.rows = inserted.length;
      return this.returning ? this.result(inserted) : { data: null, error: null };
    }

    let found = all.filter((r) => this.filters.every((f) => matches(r, f)));

    if (this.op === 'update') {
      const patch = this.payload as Row;
      for (const row of found) {
        const statusChanged = 'status' in patch && patch.status !== row.status;
        Object.assign(row, patch);
        if (this.table === 'broadcasts') row.updated_at = new Date(db.now()).toISOString();
        if (this.table === 'broadcast_recipients' && statusChanged) {
          const parent = db
            .table('broadcasts')
            .find((b) => b.id === row.broadcast_id);
          if (parent) parent.updated_at = new Date(db.now()).toISOString();
        }
      }
      entry.rows = found.length;
      return this.returning ? this.result(found) : { data: null, error: null };
    }

    if (this.op === 'delete') {
      db.tables[this.table] = all.filter((r) => !found.includes(r));
      entry.rows = found.length;
      return { data: null, error: null };
    }

    // select
    for (const { col, asc } of [...this.orders].reverse()) {
      found = [...found].sort((a, b) => {
        const x = column(a, col) as string;
        const y = column(b, col) as string;
        return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
      });
    }
    const total = found.length;
    if (this.to_ !== null) found = found.slice(this.from_, this.to_ + 1);
    if (this.limit_ !== null) found = found.slice(0, this.limit_);
    // PostgREST max-rows: the server truncates silently.
    found = found.slice(0, db.maxRows);
    entry.rows = found.length;
    return this.result(found, this.wantCount ? total : undefined);
  }
}
