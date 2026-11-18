import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getLineByPhoneNumberId,
  getLineForConversation,
  getPrimaryLine,
  listLines,
  resolveSendLine,
  LineUnavailableError,
  type WhatsAppLine,
} from './lines'

// Mock por tabla: cada .from(tabla) devuelve un builder encadenable que
// registra las llamadas y resuelve al resultado configurado para esa tabla.
type Call = { table: string; method: string; args: unknown[] }

function makeDb(results: Record<string, { data: unknown; error?: unknown }[]>) {
  const calls: Call[] = []
  const queues = Object.fromEntries(
    Object.entries(results).map(([k, v]) => [k, [...v]]),
  )
  const db = {
    from(table: string) {
      const next = () => queues[table]?.shift() ?? { data: null, error: null }
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'limit']) {
        b[m] = (...args: unknown[]) => {
          calls.push({ table, method: m, args })
          return b
        }
      }
      b.maybeSingle = () => Promise.resolve({ error: null, ...next() })
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ error: null, ...next() }).then(res, rej)
      return b
    },
  }
  return { db: db as unknown as SupabaseClient, calls }
}

const line = (over: Partial<WhatsAppLine> = {}): WhatsAppLine => ({
  id: 'line-1',
  account_id: 'acct-1',
  phone_number_id: 'PNID-1',
  waba_id: null,
  line_name: 'Principal',
  area: null,
  logo_url: null,
  is_primary: true,
  status: 'connected',
  access_token: 'enc-token',
  user_id: 'user-1',
  ...over,
})

describe('getLineForConversation', () => {
  it('devuelve la línea de conversations.line_id', async () => {
    const legal = line({ id: 'line-legal', line_name: 'Legal', is_primary: false })
    const { db } = makeDb({
      conversations: [{ data: { account_id: 'acct-1', line_id: 'line-legal' } }],
      whatsapp_config: [{ data: legal }],
    })
    expect(await getLineForConversation(db, 'conv-1')).toEqual(legal)
  })

  it('sin line_id cae a la línea principal de la cuenta', async () => {
    const principal = line()
    const { db, calls } = makeDb({
      conversations: [{ data: { account_id: 'acct-1', line_id: null } }],
      whatsapp_config: [{ data: principal }],
    })
    expect(await getLineForConversation(db, 'conv-1')).toEqual(principal)
    expect(
      calls.some((c) => c.table === 'whatsapp_config' && c.method === 'eq' && c.args[0] === 'account_id' && c.args[1] === 'acct-1'),
    ).toBe(true)
  })

  it('cuenta sin líneas devuelve null', async () => {
    const { db } = makeDb({
      conversations: [{ data: { account_id: 'acct-1', line_id: null } }],
      whatsapp_config: [{ data: null }],
    })
    expect(await getLineForConversation(db, 'conv-1')).toBeNull()
  })

  it('conversación inexistente devuelve null', async () => {
    const { db } = makeDb({ conversations: [{ data: null }] })
    expect(await getLineForConversation(db, 'nope')).toBeNull()
  })
})

describe('getPrimaryLine', () => {
  it('devuelve null si la cuenta no tiene líneas', async () => {
    const { db } = makeDb({ whatsapp_config: [{ data: null }] })
    expect(await getPrimaryLine(db, 'acct-1')).toBeNull()
  })
})

describe('listLines', () => {
  it('ordena por sort_order y filtra por cuenta', async () => {
    const rows = [line({ id: 'a' }), line({ id: 'b', is_primary: false })]
    const { db, calls } = makeDb({ whatsapp_config: [{ data: rows }] })
    expect(await listLines(db, 'acct-1')).toEqual(rows)
    expect(calls.some((c) => c.method === 'order' && c.args[0] === 'sort_order')).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'account_id' && c.args[1] === 'acct-1')).toBe(true)
  })

  it('devuelve [] si no hay filas', async () => {
    const { db } = makeDb({ whatsapp_config: [{ data: null }] })
    expect(await listLines(db, 'acct-1')).toEqual([])
  })
})

describe('getLineByPhoneNumberId', () => {
  it('devuelve la línea que coincide', async () => {
    const l = line()
    const { db, calls } = makeDb({ whatsapp_config: [{ data: l }] })
    expect(await getLineByPhoneNumberId(db, 'PNID-1')).toEqual(l)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'phone_number_id' && c.args[1] === 'PNID-1')).toBe(true)
  })

  it('devuelve null si no hay ninguna', async () => {
    const { db } = makeDb({ whatsapp_config: [{ data: null }] })
    expect(await getLineByPhoneNumberId(db, 'x')).toBeNull()
  })
})

describe('resolveSendLine', () => {
  it('con conversación usa la línea de la conversación', async () => {
    const b = line({ id: 'line-B', is_primary: false })
    const { db } = makeDb({
      conversations: [{ data: { account_id: 'acct-1', line_id: 'line-B' } }],
      whatsapp_config: [{ data: b }],
    })
    expect(await resolveSendLine(db, 'acct-1', { conversationId: 'cv-1' })).toEqual(b)
  })

  it('con line_id sin conversación pide esa línea dentro de la cuenta', async () => {
    const b = line({ id: 'line-B', is_primary: false })
    const { db, calls } = makeDb({ whatsapp_config: [{ data: b }] })
    expect(await resolveSendLine(db, 'acct-1', { lineId: 'line-B' })).toEqual(b)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'id' && c.args[1] === 'line-B')).toBe(true)
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'account_id' && c.args[1] === 'acct-1')).toBe(true)
  })

  it('sin nada cae a la principal', async () => {
    const a = line()
    const { db } = makeDb({ whatsapp_config: [{ data: a }] })
    expect(await resolveSendLine(db, 'acct-1')).toEqual(a)
  })

  it('una conversación de otra cuenta no presta su línea (lanza, no usa la principal)', async () => {
    const other = line({ id: 'x', account_id: 'acct-2' })
    const mine = line()
    const { db } = makeDb({
      conversations: [{ data: { account_id: 'acct-2', line_id: 'x' } }],
      whatsapp_config: [{ data: other }, { data: mine }],
    })
    await expect(resolveSendLine(db, 'acct-1', { conversationId: 'cv-9' })).rejects.toBeInstanceOf(
      LineUnavailableError,
    )
    void mine
  })
})

describe('resolveSendLine — sin caer a la principal', () => {
  const conv = { data: { account_id: 'acct-1', line_id: 'line-B' } }

  it('conversación con line_id y error al leer la línea lanza LineUnavailableError', async () => {
    const { db, calls } = makeDb({
      conversations: [conv],
      whatsapp_config: [{ data: null, error: { message: 'timeout' } }, { data: line() }],
    })
    await expect(resolveSendLine(db, 'acct-1', { conversationId: 'cv-1' })).rejects.toBeInstanceOf(
      LineUnavailableError,
    )
    // No llegó a pedir la principal (is_primary).
    expect(calls.some((c) => c.method === 'order' && c.args[0] === 'is_primary')).toBe(false)
  })

  it('conversación con line_id cuya línea no existe lanza LineUnavailableError', async () => {
    const { db } = makeDb({ conversations: [conv], whatsapp_config: [{ data: null }, { data: line() }] })
    await expect(resolveSendLine(db, 'acct-1', { conversationId: 'cv-1' })).rejects.toBeInstanceOf(
      LineUnavailableError,
    )
  })

  it('error al leer la conversación lanza en vez de usar la principal', async () => {
    const { db } = makeDb({
      conversations: [{ data: null, error: { message: 'timeout' } }],
      whatsapp_config: [{ data: line() }],
    })
    await expect(resolveSendLine(db, 'acct-1', { conversationId: 'cv-1' })).rejects.toBeInstanceOf(
      LineUnavailableError,
    )
  })

  it('line_id NULL sigue usando la principal', async () => {
    const a = line()
    const { db } = makeDb({
      conversations: [{ data: { account_id: 'acct-1', line_id: null } }],
      whatsapp_config: [{ data: a }],
    })
    expect(await resolveSendLine(db, 'acct-1', { conversationId: 'cv-1' })).toEqual(a)
  })

  it('getLineById con error de la base lanza', async () => {
    const { db } = makeDb({ whatsapp_config: [{ data: null, error: { message: 'x' } }] })
    await expect(resolveSendLine(db, 'acct-1', { lineId: 'line-B' })).rejects.toBeInstanceOf(
      LineUnavailableError,
    )
  })
})
