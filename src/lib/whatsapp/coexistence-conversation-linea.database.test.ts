import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Usa la función REAL: la definición de 079 y, encima, la sección 6 de 103
// (aplicada dos veces para comprobar que es idempotente).
const db = new PGlite()
const sql = (name: string) => readFileSync(`supabase/migrations/${name}.sql`, 'utf8')
const account = '00000000-0000-0000-0000-000000000001'
const user = '00000000-0000-0000-0000-0000000000a1'
const contact = '00000000-0000-0000-0000-000000000002'
const lineA = '00000000-0000-0000-0000-0000000000b1'
const lineB = '00000000-0000-0000-0000-0000000000b2'
const resolve = (line: string | null) =>
  db.query<{ id: string; line_id: string | null; area: string | null }>(
    'SELECT id, line_id, area FROM coexistence_conversation($1,$2,$3,$4)', [account, user, contact, line])

beforeAll(async () => {
  const s079 = sql('079_whatsapp_coexistence_sync')
  const ini = s079.indexOf('CREATE OR REPLACE FUNCTION public.coexistence_conversation(')
  const fin = s079.indexOf('$$;', ini) + 3
  const s103 = sql('103_whatsapp_lineas')
  const sec = s103.slice(s103.indexOf('-- 6. coexistence_conversation por línea'), s103.lastIndexOf('COMMIT;'))
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE contacts(id uuid PRIMARY KEY, account_id uuid);
    CREATE TABLE whatsapp_config(id uuid PRIMARY KEY, account_id uuid, is_primary boolean DEFAULT false, area text);
    CREATE TABLE conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, user_id uuid,
      contact_id uuid, line_id uuid, area text, created_at timestamptz DEFAULT clock_timestamp());
    INSERT INTO contacts VALUES ('${contact}', '${account}');
    INSERT INTO whatsapp_config VALUES ('${lineA}', '${account}', true, 'ventas'), ('${lineB}', '${account}', false, 'cobranzas');
    ${s079.slice(ini, fin)}
    GRANT EXECUTE ON FUNCTION public.coexistence_conversation(UUID, UUID, UUID) TO service_role;
  `)
  await db.exec(sec)
  await db.exec(sec)
})
afterAll(() => db.close())

describe('coexistence_conversation por línea (103 sección 6)', () => {
  it('(c) crea el hilo con line_id y el área de la línea cuando no existe', async () => {
    const a = (await resolve(lineA)).rows[0]
    expect(a).toMatchObject({ line_id: lineA, area: 'ventas' })
    const b = (await resolve(lineB)).rows[0]
    expect(b).toMatchObject({ line_id: lineB, area: 'cobranzas' })
    expect(b.id).not.toBe(a.id)
  })
  it('(a) con hilos en A y B devuelve el de cada línea', async () => {
    const a = (await resolve(lineA)).rows[0]
    const b = (await resolve(lineB)).rows[0]
    expect(a.line_id).toBe(lineA)
    expect(b.line_id).toBe(lineB)
    expect((await db.query('SELECT count(*)::int AS n FROM conversations')).rows).toEqual([{ n: 2 }])
  })
  it('(b) con p_line NULL conserva el comportamiento anterior: el primer hilo', async () => {
    const first = (await db.query<{ id: string }>('SELECT id FROM conversations ORDER BY created_at, id LIMIT 1')).rows[0]
    expect((await resolve(null)).rows[0].id).toBe(first.id)
    expect((await db.query<{ id: string }>('SELECT (coexistence_conversation($1,$2,$3)).id', [account, user, contact])).rows[0].id).toBe(first.id)
  })
  it('un hilo antiguo sin línea lo reutiliza solo la principal', async () => {
    await db.exec(`DELETE FROM conversations; INSERT INTO conversations(id, account_id, user_id, contact_id) VALUES (gen_random_uuid(), '${account}', '${user}', '${contact}')`)
    const old = (await db.query<{ id: string }>('SELECT id FROM conversations')).rows[0].id
    expect((await resolve(lineB)).rows[0].id).not.toBe(old)
    expect((await resolve(lineA)).rows[0].id).toBe(old)
  })
})
