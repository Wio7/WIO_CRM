import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const db = new PGlite();
const owner = '00000000-0000-0000-0000-000000000001';
const worker = '00000000-0000-0000-0000-000000000002';
const outsider = '00000000-0000-0000-0000-000000000003';
const golden = '00000000-0000-0000-0000-000000000011';
const foreign = '00000000-0000-0000-0000-000000000012';
async function as(user: string) { await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [user]); }
async function rpc<T>(name: string, args = ''): Promise<T> {
  const { rows } = await db.query<{ data: T }>(`SELECT ${name}(${args}) AS data`);
  return rows[0].data;
}
async function command(body: Record<string, unknown>) {
  const { rows } = await db.query<{ data: string }>('SELECT cash_company_command($1::jsonb) AS data', [JSON.stringify(body)]);
  return rows[0].data;
}
beforeAll(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    CREATE TABLE public.accounts(id uuid PRIMARY KEY, name text, owner_user_id uuid NOT NULL REFERENCES auth.users(id));
    CREATE TABLE public.profiles(user_id uuid PRIMARY KEY, account_id uuid, account_role text, full_name text, email text);
    INSERT INTO auth.users VALUES ('${owner}'), ('${worker}'), ('${outsider}');
    INSERT INTO accounts VALUES ('${golden}', 'Golden Habitat', '${owner}'), ('${foreign}', 'Otra organización', '${outsider}');
    INSERT INTO profiles VALUES
      ('${owner}', '${golden}', 'owner', 'Dueño', 'owner@test.local'),
      ('${worker}', '${golden}', 'agent', 'Trabajador', 'worker@test.local'),
      ('${outsider}', '${foreign}', 'owner', 'Ajeno', 'other@test.local');
  `);
  await db.exec(readFileSync('supabase/migrations/063_golden_caja.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/064_cash_private_boxes_audit.sql', 'utf8'));
  await db.exec('SET ROLE authenticated');
  await as(owner);
  await db.query('SELECT cash_command($1::jsonb)', [JSON.stringify({ action: 'entry', requestId: randomUUID(), kind: 'income', amountCents: 10000, concept: 'Prueba Golden', counterparty: 'Caja inicial', date: '2026-01-01' })]);
  await db.query('SELECT cash_command($1::jsonb)', [JSON.stringify({ action: 'member', userId: worker, role: 'cashier' })]);
  await db.exec('RESET ROLE');
  await db.exec(readFileSync('supabase/migrations/065_cash_companies.sql', 'utf8'));
  await db.exec('SET ROLE authenticated');
}, 30000);
afterAll(async () => { await db.close(); });

describe.sequential('cash company selection and isolation', () => {
  let cafe: string;
  it('preserves Golden movements and seeds three separate empty companies', async () => {
    await as(owner);
    const list = await rpc<{ id: string; name: string; role: string }[]>('cash_company_list');
    expect(list.map((c) => c.name)).toEqual(expect.arrayContaining(['Golden Habitat', 'Cafetería', 'Restaurante', 'La Jato · Hacienda']));
    expect(list).toHaveLength(4);
    cafe = list.find((c) => c.name === 'Cafetería')!.id;
    const goldenSnapshot = await rpc<{ income: number; entryCount: number }>('cash_company_snapshot', `'${golden}'`);
    const cafeSnapshot = await rpc<{ income: number; entryCount: number }>('cash_company_snapshot', `'${cafe}'`);
    expect(goldenSnapshot.income).toBe(10000);
    expect(goldenSnapshot.entryCount).toBe(1);
    expect(cafeSnapshot.income).toBe(0);
    expect(cafeSnapshot.entryCount).toBe(0);
  });
  it('limits a worker to their assigned company and their own records', async () => {
    await as(worker);
    expect((await rpc<{ id: string }[]>('cash_company_list')).map((c) => c.id)).toEqual([golden]);
    await expect(rpc('cash_company_snapshot', `'${cafe}'`)).rejects.toThrow('Sin acceso financiero');
    const id = await command({ action: 'entry', companyId: golden, requestId: randomUUID(), kind: 'expense', amountCents: 2300, concept: 'Varilla', counterparty: 'Ferretería', date: '2026-01-01' });
    const own = await rpc<{ income: number; expense: number; entryCount: number }>('cash_company_snapshot', `'${golden}'`);
    expect(own.income).toBe(0);
    expect(own.expense).toBe(2300);
    expect(own.entryCount).toBe(1);
    await expect(command({ action: 'entry', companyId: cafe, requestId: randomUUID(), kind: 'expense', amountCents: 1, concept: 'Ajeno', counterparty: 'X', date: '2026-01-01' })).rejects.toThrow('Sin permiso');
    await as(owner);
    const all = await rpc<{ income: number; expense: number; entryCount: number }>('cash_company_snapshot', `'${golden}'`);
    expect(all.income).toBe(10000);
    expect(all.expense).toBe(2300);
    expect(all.entryCount).toBe(2);
    expect((await rpc<{ entryCount: number }>('cash_company_snapshot', `'${cafe}'`)).entryCount).toBe(0);
    expect(id).toBeTruthy();
  });
  it('keeps another CRM organization isolated', async () => {
    await as(outsider);
    expect((await rpc<{ id: string }[]>('cash_company_list')).map((c) => c.id)).toEqual([foreign]);
    await expect(rpc('cash_company_export', `'${golden}'`)).rejects.toThrow('Sin acceso financiero');
  });
});
