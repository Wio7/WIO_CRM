import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Execute the actual migration against disposable PostgreSQL (WASM).
// Only the preexisting Supabase identity/account tables are fixtures.
const db = new PGlite();
const owner = '00000000-0000-0000-0000-000000000001';
const cashier = '00000000-0000-0000-0000-000000000002';
const reader = '00000000-0000-0000-0000-000000000003';
const outsider = '00000000-0000-0000-0000-000000000004';
const admin = '00000000-0000-0000-0000-000000000005';
const org = '00000000-0000-0000-0000-000000000011';
const otherOrg = '00000000-0000-0000-0000-000000000012';
async function as(user: string) {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [
    user,
  ]);
}
async function command(c: Record<string, unknown>) {
  const result = await db.query<{ id: string }>(
    'SELECT cash_command($1::jsonb) AS id',
    [JSON.stringify(c)]
  );
  return result.rows[0].id;
}
async function snapshot() {
  const result = await db.query<{
    data: {
      income: number;
      expense: number;
      entryCount: number;
      budgets: { spent: number }[];
      entries: { id: string; reversed: boolean }[];
      audit: { entry_id: string; action: string; before_data: { amount_cents: number } | null; after_data: { amount_cents: number }; reason: string }[];
      boxes: { userId: string; income: number; expense: number; entryCount: number }[];
    };
  }>('SELECT cash_snapshot() AS data');
  return result.rows[0].data;
}
beforeAll(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, name text);
    CREATE TABLE public.profiles(user_id uuid PRIMARY KEY, account_id uuid, account_role text, full_name text, email text);
    INSERT INTO auth.users VALUES ('${owner}'), ('${cashier}'), ('${reader}'), ('${outsider}'), ('${admin}');
    INSERT INTO accounts VALUES ('${org}', 'Golden Test'), ('${otherOrg}', 'Otra organización');
    INSERT INTO profiles VALUES
      ('${owner}', '${org}', 'owner', 'Owner', 'owner@test.local'),
      ('${cashier}', '${org}', 'agent', 'Cashier', 'cashier@test.local'),
      ('${reader}', '${org}', 'viewer', 'Reader', 'reader@test.local'),
      ('${admin}', '${org}', 'admin', 'Admin', 'admin@test.local'),
      ('${outsider}', '${otherOrg}', 'owner', 'Outsider', 'outsider@test.local');
  `);
  await db.exec(
    readFileSync('supabase/migrations/063_golden_caja.sql', 'utf8')
  );
  await db.exec(readFileSync('supabase/migrations/064_cash_private_boxes_audit.sql', 'utf8'));
  await db.exec('SET ROLE authenticated');
}, 30000);
afterAll(async () => {
  await db.close();
});

describe.sequential('cash database authorization and ledger', () => {
  let budget: string;
  let expense: string;
  let income: string;
  it('denies anonymous identities, sales agents and ordinary admins', async () => {
    for (const user of ['', cashier, admin]) {
      await as(user);
      await expect(snapshot()).rejects.toThrow('Sin acceso financiero');
    }
    await as(owner);
    expect((await snapshot()).income).toBe(0);
    await command({ action: 'member', userId: cashier, role: 'cashier' });
    await command({ action: 'member', userId: reader, role: 'reader' });
    await expect(
      command({ action: 'member', userId: outsider, role: 'cashier' })
    ).rejects.toThrow('Integrante no válido');
  });
  it('keeps allocations separate from cash and makes retries idempotent', async () => {
    const c = {
      action: 'entry',
      requestId: randomUUID(),
      kind: 'income',
      amountCents: 500000,
      concept: 'Fondo',
      counterparty: 'Administración',
      date: '2026-01-01',
    };
    income = await command(c);
    expect(await command(c)).toBe(income);
    budget = randomUUID();
    await command({
      action: 'budget',
      requestId: budget,
      amountCents: 100000,
      name: 'Movilidad',
    });
    const s = await snapshot();
    expect(s.income).toBe(500000);
    expect(s.expense).toBe(0);
    expect(s.entryCount).toBe(1);
    expect(s.budgets[0].spent).toBe(0);
  });
  it('allows a cashier to record expenses but not grant access or mutate ledger rows', async () => {
    await as(cashier);
    budget = randomUUID();
    await command({ action: 'budget', requestId: budget, amountCents: 100000, name: 'Caja del encargado' });
    expense = await command({
      action: 'entry',
      requestId: randomUUID(),
      kind: 'expense',
      amountCents: 10000,
      concept: 'Taxi',
      counterparty: 'Transportista',
      date: '2026-01-01',
      budgetId: budget,
    });
    const s = await snapshot();
    expect(s.income - s.expense).toBe(-10000);
    expect(s.budgets[0].spent).toBe(10000);
    await expect(
      command({ action: 'member', userId: reader, role: 'cashier' })
    ).rejects.toThrow('Solo el propietario');
    await expect(
      db.query('DELETE FROM cash_entries WHERE id = $1', [expense])
    ).rejects.toThrow('permission denied');
    await expect(
      db.query('UPDATE cash_entries SET amount_cents = 1 WHERE id = $1', [
        expense,
      ])
    ).rejects.toThrow('permission denied');
    await expect(
      db.query("INSERT INTO cash_members VALUES ($1, $2, 'cashier')", [
        org,
        reader,
      ])
    ).rejects.toThrow('permission denied');
  });
  it('denies writes to a reader and isolates another organization through both RPC and RLS', async () => {
    await as(reader);
    expect((await snapshot()).expense).toBe(0);
    await expect(
      command({
        action: 'budget',
        requestId: randomUUID(),
        amountCents: 1000,
        name: 'Forbidden',
      })
    ).rejects.toThrow('Sin permiso');
    await as(outsider);
    expect((await snapshot()).entryCount).toBe(0);
    expect((await db.query('SELECT * FROM cash_entries')).rows).toHaveLength(0);
    await expect(
      command({
        action: 'reverse',
        requestId: randomUUID(),
        entryId: expense,
        reason: 'Prueba ajena',
      })
    ).rejects.toThrow('no se puede modificar');
    await expect(
      command({
        action: 'entry',
        requestId: randomUUID(),
        kind: 'expense',
        amountCents: 1000,
        concept: 'Taxi',
        counterparty: 'Test',
        date: '2026-01-01',
        budgetId: budget,
      })
    ).rejects.toThrow('Presupuesto no válido');
  });
  it('reverses income and expense exactly once, preserving both originals and budget availability', async () => {
    await as(cashier);
    const c = {
      action: 'reverse',
      requestId: randomUUID(),
      entryId: expense,
      reason: 'Registro equivocado',
    };
    const reversal = await command(c);
    expect(await command(c)).toBe(reversal);
    await expect(command({ ...c, requestId: randomUUID() })).rejects.toThrow(
      'no se puede modificar'
    );
    await expect(
      command({ ...c, requestId: randomUUID(), entryId: reversal })
    ).rejects.toThrow('no se puede modificar');
    let s = await snapshot();
    expect(s.expense).toBe(0);
    expect(s.budgets[0].spent).toBe(0);
    expect(s.income).toBe(0);
    expect(s.entries.find((e) => e.id === expense)?.reversed).toBe(true);
    await as(owner);
    await command({
      action: 'reverse',
      requestId: randomUUID(),
      entryId: income,
      reason: 'Fondo registrado por error',
    });
    s = await snapshot();
    expect(s.income).toBe(0);
    expect(s.entryCount).toBe(4);
  });
  it('keeps all independent queued writes and counts records beyond the displayed 100', async () => {
    await as(cashier);
    await Promise.all(
      Array.from({ length: 105 }, (_, i) =>
        command({
          action: 'entry',
          requestId: randomUUID(),
          kind: 'income',
          amountCents: 29,
          concept: `Ingreso ${i}`,
          counterparty: 'Prueba',
          date: '2026-01-01',
        })
      )
    );
    const s = await snapshot();
    expect(s.income).toBe(3045);
    expect(s.entries).toHaveLength(100);
    expect(s.entryCount).toBe(107);
  });
  it('revokes access even for an already signed-in cashier', async () => {
    await as(owner);
    await command({ action: 'member', userId: cashier, role: 'none' });
    await as(cashier);
    await expect(snapshot()).rejects.toThrow('Sin acceso financiero');
    expect((await db.query('SELECT * FROM cash_entries')).rows).toHaveLength(0);
  });
  it('keeps employee boxes private and records precise before/after edits for the owner', async () => {
    await as(owner);
    await command({ action: 'member', userId: cashier, role: 'cashier' });
    const ownerEntry = await command({ action: 'entry', requestId: randomUUID(), kind: 'expense', amountCents: 500, concept: 'Compra dueño', counterparty: 'Tienda', date: '2026-01-01' });
    await as(cashier);
    const id = await command({ action: 'entry', requestId: randomUUID(), kind: 'expense', amountCents: 1000, concept: 'Varilla', counterparty: 'Ferretería', date: '2026-01-01' });
    const row = await db.query<{ updated_at: string }>('SELECT updated_at FROM cash_entries WHERE id = $1', [id]);
    const edit = { action: 'edit', requestId: randomUUID(), entryId: id, expectedUpdatedAt: row.rows[0].updated_at, amountCents: 1900, concept: 'Varilla', counterparty: 'Ferretería', date: '2026-01-01', reason: 'Corrección de factura' };
    expect(await command(edit)).toBe(id);
    expect(await command(edit)).toBe(id);
    const own = await snapshot();
    expect(own.entries.some((e) => e.id === income)).toBe(false);
    const ownExport = await db.query<{ data: { entries: { id: string }[]; audit: unknown[] } }>('SELECT cash_export() AS data');
    expect(ownExport.rows[0].data.entries.some((e) => e.id === ownerEntry)).toBe(false);
    expect(ownExport.rows[0].data.audit).toHaveLength(0);
    await expect(command({ ...edit, requestId: randomUUID(), entryId: ownerEntry })).rejects.toThrow('propia caja');
    await as(owner);
    const all = await snapshot();
    expect(all.entries.some((e) => e.id === id)).toBe(true);
    expect(all.boxes.find((b) => b.userId === cashier)?.expense).toBe(1900);
    expect(all.boxes.find((b) => b.userId === owner)?.entryCount).toBeGreaterThan(0);
    const ownerExport = await db.query<{ data: { entries: { id: string }[]; audit: unknown[] } }>('SELECT cash_export() AS data');
    expect(ownerExport.rows[0].data.entries.some((e) => e.id === id)).toBe(true);
    const history = all.audit.find((h) => h.entry_id === id && h.action === 'edited');
    expect(history?.before_data?.amount_cents).toBe(1000);
    expect(history?.after_data.amount_cents).toBe(1900);
    expect(history?.reason).toBe('Corrección de factura');
  });
});
