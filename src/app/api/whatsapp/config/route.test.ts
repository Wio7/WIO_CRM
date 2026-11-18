import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DELETE, GET, POST } from './route'

type Row = Record<string, unknown>
const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  claimed: false,
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
      const filters: Array<[string, unknown]> = []
      const orders: Array<[string, boolean]> = []
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
      let payload: Row = {}
      const matches = () => state.rows.filter((r) => filters.every(([k, v]) => r[k] === v))
      const run = () => {
        if (op === 'insert') {
          state.writes++
          state.rows.push({ id: `line-${++state.seq}`, is_primary: false, sort_order: 0, line_name: 'Principal', ...payload })
          return { data: null, error: null }
        }
        if (op === 'update') { state.writes++; matches().forEach((r) => Object.assign(r, payload)); return { data: null, error: null } }
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
  state.rows = []; state.claimed = false; state.writes = 0; state.seq = 0
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
  it('line_id ajeno: 404 sin borrar', async () => {
    state.rows = [line({})]
    expect((await del('?line_id=nope')).status).toBe(404)
    expect(state.rows).toHaveLength(1)
  })
})
