import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'

type Row = Record<string, unknown>
const state = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))
const meta = vi.hoisted(() => ({ verifyPhoneNumber: vi.fn(), getSubscribedApps: vi.fn() }))

vi.mock('@/lib/whatsapp/meta-api', () => meta)
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => {
      const filters: Array<[string, unknown]> = []
      const orders: Array<[string, boolean]> = []
      const run = () => {
        if (table === 'profiles') return [{ account_id: 'acc' }]
        const out = state.rows.filter((r) => filters.every(([k, v]) => r[k] === v))
        out.sort((a, b) => {
          for (const [k, asc] of orders) {
            const d = Number(a[k] as number) - Number(b[k] as number)
            if (d) return asc ? d : -d
          }
          return 0
        })
        return out
      }
      const b = {
        select: () => b,
        eq: (k: string, v: unknown) => { filters.push([k, v]); return b },
        order: (k: string, o: { ascending: boolean }) => { orders.push([k, o.ascending]); return b },
        limit: () => b,
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      }
      return b
    },
  }),
}))

const line = (over: Row): Row => ({
  id: 'l1', account_id: 'acc', phone_number_id: '111', waba_id: 'w1', line_name: 'Principal', area: null,
  logo_url: null, is_primary: true, sort_order: 0, status: 'connected', disconnected_at: null,
  access_token: 'enc:tok-secret', registered_at: '2026-11-01T00:00:00Z', subscribed_apps_at: null,
  last_registration_error: null, ...over,
})
const get = (qs = '') => GET(new Request(`http://localhost/api/whatsapp/config/verify-registration${qs}`))

beforeEach(() => {
  vi.clearAllMocks()
  state.rows = []
  meta.verifyPhoneNumber.mockResolvedValue({})
  meta.getSubscribedApps.mockResolvedValue([{ id: 'app' }])
})

describe('GET /api/whatsapp/config/verify-registration', () => {
  it('una línea: igual que antes, sin tokens', async () => {
    state.rows = [line({})]
    const res = await get()
    const json = await res.json()
    expect(json).toMatchObject({ live: true, errors: [], registered_at: '2026-11-01T00:00:00Z' })
    expect(JSON.stringify(json)).not.toContain('tok-secret')
    expect(meta.verifyPhoneNumber).toHaveBeenCalledWith({ phoneNumberId: '111', accessToken: 'tok-secret' })
  })
  it('sin líneas: config_exists false', async () => {
    expect(await (await get()).json()).toMatchObject({ live: false, checks: { config_exists: false } })
  })
  it('dos líneas con line_id verifica esa línea', async () => {
    state.rows = [line({}), line({ id: 'l2', phone_number_id: '222', waba_id: 'w2', is_primary: false, sort_order: 1, access_token: 'enc:tok-2' })]
    await get('?line_id=l2')
    expect(meta.verifyPhoneNumber).toHaveBeenCalledWith({ phoneNumberId: '222', accessToken: 'tok-2' })
    expect(meta.getSubscribedApps).toHaveBeenCalledWith({ wabaId: 'w2', accessToken: 'tok-2' })
  })
  it('dos líneas sin line_id usa la principal', async () => {
    state.rows = [line({ id: 'l2', phone_number_id: '222', is_primary: false, sort_order: 0 }), line({ id: 'l1', is_primary: true, sort_order: 1 })]
    await get()
    expect(meta.verifyPhoneNumber).toHaveBeenCalledWith({ phoneNumberId: '111', accessToken: 'tok-secret' })
  })
  it('line_id de otra cuenta: 404 y no llama a Meta', async () => {
    state.rows = [line({}), line({ id: 'x1', account_id: 'otra', phone_number_id: '999' })]
    expect((await get('?line_id=x1')).status).toBe(404)
    expect(meta.verifyPhoneNumber).not.toHaveBeenCalled()
  })
})
