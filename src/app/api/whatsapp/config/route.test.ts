import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DELETE, GET, POST } from './route'

type Row = Record<string, unknown>
const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  claimed: false,
  convs: [] as Array<Record<string, unknown>>,
  log: [] as string[],
  writes: 0,
  seq: 0,
}))
const meta = vi.hoisted(() => ({
  verifyPhoneNumber: vi.fn(),
  registerPhoneNumber: vi.fn(),
  subscribeWabaToApp: vi.fn(),
}))

vi.mock('@/lib/whatsapp/meta-api', () => meta)
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => {
      const b = {
        select: () => b, eq: () => b, neq: () => b,
        maybeSingle: async () => ({ data: state.claimed ? { account_id: 'other' } : null, error: null }),
      }
      return b
    },
  }),
}))

// Base en memoria con lo justo del cliente de Supabase que usa la ruta.
function fakeDb() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => {
      if (table === 'profiles') {
        const p = { select: () => p, eq: () => p, maybeSingle: async () => ({ data: { account_id: 'acc' }, error: null }) }
        return p
      }
      const isConv = table === 'conversations'
      const filters: Array<[string, unknown]> = []
      const orders: Array<[string, boolean]> = []
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
      let payload: Row = {}
      const matches = () => (isConv ? state.convs : state.rows).filter((r) => filters.every(([k, v]) => r[k] === v))
      const run = () => {
        if (op === 'insert') {
          state.writes++
          state.rows.push({ id: `line-${++state.seq}`, is_primary: false, sort_order: 0, line_name: 'Principal', ...payload })
          return { data: null, error: null }
        }
        if (isConv) return { data: null, count: matches().length, error: null }
        if (op === 'update') { state.writes++; state.log.push(`update:${String(payload.is_primary ?? payload.status)}:${String(filters.find(([k]) => k === 'id')?.[1])}`); matches().forEach((r) => Object.assign(r, payload)); return { data: null, error: null } }
        if (op === 'delete') { state.writes++; const m = matches(); state.rows = state.rows.filter((r) => !m.includes(r)); return { data: null, error: null } }
        const out = [...matches()]
        out.sort((a, b) => {
          for (const [k, asc] of orders) {
            const d = Number(a[k] as number) - Number(b[k] as number)
            if (d) return asc ? d : -d
          }
          return 0
        })
        return { data: out, error: null }
      }
      const b = {
        select: () => b,
        eq: (k: string, v: unknown) => { filters.push([k, v]); return b },
        order: (k: string, o: { ascending: boolean }) => { orders.push([k, o.ascending]); return b },
        limit: () => b,
        insert: (row: Row) => { op = 'insert'; payload = row; return b },
        update: (row: Row) => { op = 'update'; payload = row; return b },
        delete: () => { op = 'delete'; return b },
        maybeSingle: async () => ({ data: (run().data as Row[] | null)?.[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve(run()),
      }
      return b
    },
  }
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fakeDb() }))

const line = (over: Row): Row => ({
  id: 'l1', account_id: 'acc', phone_number_id: '111', waba_id: 'w', line_name: 'Principal', area: null,
  logo_url: null, is_primary: true, sort_order: 0, status: 'connected', access_token: 'enc:tok-secret', verify_token: 'enc:vt',
  user_id: 'user-1', ...over,
})
const post = (body: Row) => POST(new Request('http://localhost/api/whatsapp/config', { method: 'POST', body: JSON.stringify(body) }))
const del = (qs = '') => DELETE(new Request(`http://localhost/api/whatsapp/config${qs}`, { method: 'DELETE' }))

beforeEach(() => {
  vi.clearAllMocks()
  state.rows = []; state.convs = []; state.log = []; state.claimed = false; state.writes = 0; state.seq = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
  meta.verifyPhoneNumber.mockResolvedValue({ display_phone_number: '+51 999' })
  meta.registerPhoneNumber.mockResolvedValue(undefined)
  meta.subscribeWabaToApp.mockResolvedValue(undefined)
})

describe('GET /api/whatsapp/config', () => {
  it('conserva connected/phone_info y agrega lines sin tokens', async () => {
    state.rows = [line({}), line({ id: 'l2', phone_number_id: '222', is_primary: false, sort_order: 1 })]
    const json = await (await GET()).json()
    expect(json).toMatchObject({ connected: true, phone_info: { display_phone_number: '+51 999' } })
    expect(json.lines.map((l: Row) => l.id)).toEqual(['l1', 'l2'])
    expect(JSON.stringify(json)).not.toContain('tok-secret')
    for (const l of json.lines) {
      expect(l).not.toHaveProperty('access_token')
      expect(l).not.toHaveProperty('verify_token')
    }
    expect(meta.verifyPhoneNumber).toHaveBeenCalledWith({ phoneNumberId: '111', accessToken: 'tok-secret' })
  })
  it('sin líneas: no_config y lines vacío', async () => {
    expect(await (await GET()).json()).toMatchObject({ connected: false, reason: 'no_config', lines: [] })
  })
})

describe('POST /api/whatsapp/config', () => {
  const base = { phone_number_id: '111', waba_id: 'w', access_token: 'tok' }
  it('la primera línea de la cuenta queda principal y se llama Principal', async () => {
    expect((await post(base)).status).toBe(200)
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ account_id: 'acc', is_primary: true, line_name: 'Principal', sort_order: 0, access_token: 'enc:tok' })
  })
  it('new_line: un número nuevo crea una línea adicional no principal al final', async () => {
    state.rows = [line({ sort_order: 4 })]
    const res = await post({ ...base, new_line: true, phone_number_id: '222', line_name: 'Ventas', area: 'ventas', logo_url: 'https://x/l.png' })
    expect(res.status).toBe(200)
    expect(state.rows).toHaveLength(2)
    expect(state.rows[1]).toMatchObject({ phone_number_id: '222', is_primary: false, sort_order: 5, line_name: 'Ventas', area: 'ventas', logo_url: 'https://x/l.png' })
    expect(state.rows[0]).toMatchObject({ phone_number_id: '111', is_primary: true })
  })
  it('re-guardar el mismo número actualiza esa fila sin duplicar', async () => {
    state.rows = [line({})]
    expect((await post({ ...base, access_token: 'nuevo' })).status).toBe(200)
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ access_token: 'enc:nuevo', is_primary: true })
  })
  it('(c) con 1 línea y número distinto la reemplaza conservando metadatos', async () => {
    state.rows = [line({ line_name: 'Mi línea', area: 'ventas', logo_url: 'u', sort_order: 3 })]
    expect((await post({ ...base, phone_number_id: '999', access_token: 'otro' })).status).toBe(200)
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ id: 'l1', phone_number_id: '999', access_token: 'enc:otro', is_primary: true, line_name: 'Mi línea', area: 'ventas', logo_url: 'u', sort_order: 3 })
  })
  it('(a) con 2+ líneas, el número de una de ellas actualiza esa línea', async () => {
    state.rows = [line({}), line({ id: 'l2', phone_number_id: '222', is_primary: false, sort_order: 1 })]
    expect((await post({ ...base, phone_number_id: '222', access_token: 'rot' })).status).toBe(200)
    expect(state.rows).toHaveLength(2)
    expect(state.rows[1]).toMatchObject({ access_token: 'enc:rot', is_primary: false })
  })
  it('(d) con 2+ líneas y número desconocido: 400 sin escribir', async () => {
    state.rows = [line({}), line({ id: 'l2', phone_number_id: '222', is_primary: false, sort_order: 1 })]
    const res = await post({ ...base, phone_number_id: '777' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('line_id')
    expect(state.rows).toHaveLength(2)
    expect(state.writes).toBe(0)
  })
  it('new_line con line_id: 400 contradictorio', async () => {
    state.rows = [line({})]
    expect((await post({ ...base, new_line: true, line_id: 'l1' })).status).toBe(400)
    expect(state.writes).toBe(0)
  })
  it('new_line con número ya existente actualiza esa línea, no duplica', async () => {
    state.rows = [line({})]
    expect((await post({ ...base, new_line: true })).status).toBe(200)
    expect(state.rows).toHaveLength(1)
  })
  it('con line_id edita esa línea', async () => {
    state.rows = [line({}), line({ id: 'l2', phone_number_id: '222', is_primary: false, sort_order: 1 })]
    expect((await post({ ...base, phone_number_id: '222', line_id: 'l2', line_name: 'Cobranzas', area: 'cobranzas' })).status).toBe(200)
    expect(state.rows[1]).toMatchObject({ line_name: 'Cobranzas', area: 'cobranzas', is_primary: false })
    expect(state.rows[0]).toMatchObject({ line_name: 'Principal' })
  })
  it('número de otra cuenta: 409 y sin escribir', async () => {
    state.claimed = true
    expect((await post(base)).status).toBe(409)
    expect(state.writes).toBe(0)
    expect(meta.verifyPhoneNumber).not.toHaveBeenCalled()
  })
  it('área inválida: 400 sin llamar a Meta', async () => {
    expect((await post({ ...base, area: 'inventada' })).status).toBe(400)
    expect(meta.verifyPhoneNumber).not.toHaveBeenCalled()
  })
  it('line_id que no es de la cuenta: 404', async () => {
    expect((await post({ ...base, line_id: 'ajena' })).status).toBe(404)
    expect(state.writes).toBe(0)
  })
})

describe('reconexión y conflictos', () => {
  const base = { phone_number_id: '222', waba_id: 'w', access_token: 'nuevo' }
  it('reconectar el mismo número reactiva la misma fila', async () => {
    state.rows = [line({}), line({ id: 'l2', phone_number_id: '222', is_primary: false, sort_order: 1, status: 'disconnected', disconnected_at: '2026-11-18T00:00:00Z', access_token: 'enc:disconnected' })]
    expect((await post(base)).status).toBe(200)
    expect(state.rows).toHaveLength(2)
    expect(state.rows[1]).toMatchObject({ id: 'l2', status: 'connected', disconnected_at: null, access_token: 'enc:nuevo' })
  })
  it('poner a una línea el número de otra línea de la misma cuenta: 409', async () => {
    state.rows = [line({}), line({ id: 'l2', phone_number_id: '222', is_primary: false, sort_order: 1 })]
    const res = await post({ ...base, line_id: 'l1' })
    expect(res.status).toBe(409)
    expect(state.rows[0]).toMatchObject({ phone_number_id: '111' })
  })
  it('GET con status disconnected por /register fallido (sin disconnected_at) sigue verificando en Meta', async () => {
    state.rows = [line({ status: 'disconnected' })]
    const json = await (await GET()).json()
    expect(json).toMatchObject({ connected: true })
    expect(meta.verifyPhoneNumber).toHaveBeenCalled()
  })
  it('GET con la principal desconectada: line_disconnected sin llamar a Meta', async () => {
    state.rows = [line({ status: 'disconnected', disconnected_at: '2026-11-18T00:00:00Z', access_token: 'enc:disconnected' })]
    const json = await (await GET()).json()
    expect(json).toMatchObject({ connected: false, reason: 'line_disconnected' })
    expect(json.lines).toHaveLength(1)
    expect(meta.verifyPhoneNumber).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/whatsapp/config', () => {
  const three = () => [
    line({}),
    line({ id: 'l3', phone_number_id: '333', is_primary: false, sort_order: 2 }),
    line({ id: 'l2', phone_number_id: '222', is_primary: false, sort_order: 1 }),
  ]
  it('con line_id borra solo esa línea', async () => {
    state.rows = three()
    expect((await del('?line_id=l2')).status).toBe(200)
    expect(state.rows.map((r) => r.id)).toEqual(['l1', 'l3'])
    expect(state.rows.find((r) => r.id === 'l1')).toMatchObject({ is_primary: true })
  })
  it('si la borrada era la principal, la de menor sort_order pasa a principal', async () => {
    state.rows = three()
    expect((await del('?line_id=l1')).status).toBe(200)
    expect(state.rows.find((r) => r.id === 'l2')).toMatchObject({ is_primary: true })
    expect(state.rows.find((r) => r.id === 'l3')).toMatchObject({ is_primary: false })
  })
  it('sin line_id actúa sobre la principal', async () => {
    state.rows = three()
    expect((await del()).status).toBe(200)
    expect(state.rows.map((r) => r.id)).toEqual(['l3', 'l2'])
    expect(state.rows.filter((r) => r.is_primary)).toHaveLength(1)
  })
  it('borrar la última línea está permitido', async () => {
    state.rows = [line({})]
    expect((await del()).status).toBe(200)
    expect(state.rows).toHaveLength(0)
  })
  it('línea con conversaciones: se conserva desconectada, con conteo y aviso', async () => {
    state.rows = three()
    state.convs = [{ id: 'c1', account_id: 'acc', line_id: 'l2' }, { id: 'c2', account_id: 'acc', line_id: 'l2' }]
    const res = await del('?line_id=l2')
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ success: true, disconnected: true, conversation_count: 2 })
    expect(json.warning).toContain('2')
    expect(state.rows.map((r) => r.id)).toEqual(['l1', 'l3', 'l2'])
    expect(state.rows.find((r) => r.id === 'l2')).toMatchObject({ status: 'disconnected', access_token: 'enc:disconnected', phone_number_id: '222' })
    expect(state.rows.find((r) => r.id === 'l2')?.disconnected_at).toEqual(expect.any(String))
    expect(state.convs).toHaveLength(2)
  })
  it('principal con conversaciones: deja de ser principal ANTES de promover a la conectada de menor sort_order', async () => {
    state.rows = [
      line({}),
      line({ id: 'l3', phone_number_id: '333', is_primary: false, sort_order: 2 }),
      line({ id: 'l2', phone_number_id: '222', is_primary: false, sort_order: 1, status: 'disconnected', disconnected_at: '2026-11-18T00:00:00Z' }),
      line({ id: 'l4', phone_number_id: '444', is_primary: false, sort_order: 3 }),
    ]
    state.convs = [{ id: 'c1', account_id: 'acc', line_id: 'l1' }]
    expect((await del('?line_id=l1')).status).toBe(200)
    expect(state.log).toEqual(['update:false:l1', 'update:true:l3'])
    expect(state.rows.find((r) => r.id === 'l1')).toMatchObject({ status: 'disconnected', is_primary: false })
    expect(state.rows.filter((r) => r.is_primary).map((r) => r.id)).toEqual(['l3'])
  })
  it('principal con conversaciones y sin otra conectada: sigue principal (desconectada)', async () => {
    state.rows = [line({})]
    state.convs = [{ id: 'c1', account_id: 'acc', line_id: 'l1' }]
    expect((await del()).status).toBe(200)
    expect(state.rows[0]).toMatchObject({ status: 'disconnected', is_primary: true })
  })
  it('conversaciones de otra línea no cuentan: se borra la fila', async () => {
    state.rows = three()
    state.convs = [{ id: 'c1', account_id: 'acc', line_id: 'l3' }]
    const json = await (await del('?line_id=l2')).json()
    expect(json).toMatchObject({ success: true, conversation_count: 0 })
    expect(state.rows.map((r) => r.id)).toEqual(['l1', 'l3'])
  })
  it('line_id ajeno: 404 sin borrar', async () => {
    state.rows = [line({})]
    expect((await del('?line_id=nope')).status).toBe(404)
    expect(state.rows).toHaveLength(1)
  })
})
