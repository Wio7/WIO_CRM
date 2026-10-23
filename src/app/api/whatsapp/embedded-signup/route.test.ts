import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { POST } from './route'
import { requireRole, ForbiddenError } from '@/lib/auth/account'

const state = vi.hoisted(() => ({ claimed: false, conflict: false, existing: null as Record<string, unknown> | null, saved: {} as Record<string, unknown>, syncFailure: false, reserved: true }))
const mocks = vi.hoisted(() => ({ connect: vi.fn(), sync: vi.fn() }))
vi.mock('@/lib/auth/account', () => {
  class UnauthorizedError extends Error { status = 401 }
  class ForbiddenError extends Error { status = 403 }
  return { requireRole: vi.fn(), UnauthorizedError, ForbiddenError }
})
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: () => 'encrypted-token' }))
vi.mock('@/lib/whatsapp/embedded-signup', () => ({ embeddedSignupApi: () => mocks, SignupError: class extends Error {} }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: () => {
  const b = { select: () => b, eq: () => b, neq: () => b, maybeSingle: async () => ({ data: state.claimed ? { account_id: 'other' } : null, error: null }) }
  return b
} }) }))
function database() {
  return { from: () => {
    let updating = false
    const b = {
      select: () => updating ? Promise.resolve({ data: state.reserved ? [{ account_id: 'account' }] : [], error: null }) : b,
      eq: () => b, is: () => b,
      maybeSingle: async () => ({ data: state.existing, error: null }),
      upsert: async (row: Record<string, unknown>) => { state.saved = row; return { error: state.conflict ? { code: '23505' } : null } },
      update: (row: Record<string, unknown>) => { Object.assign(state.saved, row); updating = true; return b },
    }
    return b
  } }
}
const body = { code: 'code', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', phone_number_id: '123', waba_id: '456' }
const request = (payload: unknown = body) => new Request('http://localhost/api/whatsapp/embedded-signup', { method: 'POST', body: JSON.stringify(payload) })
beforeEach(() => {
  vi.clearAllMocks()
  state.claimed = false; state.conflict = false; state.existing = null; state.saved = {}; state.reserved = true
  vi.stubEnv('META_APP_ID', 'app'); vi.stubEnv('META_APP_SECRET', 'secret')
  vi.mocked(requireRole).mockResolvedValue({ supabase: database(), accountId: 'account', userId: 'user' } as unknown as Awaited<ReturnType<typeof requireRole>>)
  mocks.connect.mockResolvedValue({ token: 'secret-token', phone: { is_on_biz_app: true, platform_type: 'CLOUD_API' } })
  mocks.sync.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllEnvs())
describe('POST embedded-signup', () => {
  it('exige admin', async () => {
    vi.mocked(requireRole).mockRejectedValueOnce(new ForbiddenError())
    expect((await POST(request())).status).toBe(403)
    expect(requireRole).toHaveBeenCalledWith('admin')
    expect(mocks.connect).not.toHaveBeenCalled()
  })
  it('rechaza datos incompletos', async () => expect((await POST(request({ code: 'x' }))).status).toBe(400))
  it('rechaza variables ausentes antes de Graph', async () => {
    vi.stubEnv('META_APP_SECRET', '')
    expect((await POST(request())).status).toBe(503)
    expect(mocks.connect).not.toHaveBeenCalled()
  })
  it('devuelve 409 antes de Graph para otra cuenta', async () => {
    state.claimed = true
    expect((await POST(request())).status).toBe(409)
    expect(mocks.connect).not.toHaveBeenCalled()
  })
  it('devuelve 409 también ante conflicto concurrente', async () => {
    state.conflict = true
    expect((await POST(request())).status).toBe(409)
    expect(mocks.sync).not.toHaveBeenCalled()
  })
  it('guarda cifrado y solicita contactos antes del historial', async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(state.saved).toMatchObject({ access_token: 'encrypted-token', connection_type: 'coexistence', status: 'connected', account_id: 'account', user_id: 'user' })
    expect(mocks.sync.mock.calls.map(c => c[2])).toEqual(['smb_app_state_sync', 'history'])
    expect(await response.json()).toMatchObject({ registered: true, registration_skipped: false })
  })
  it('fallo de sync no falla conexión y se guarda sin secretos', async () => {
    mocks.sync.mockRejectedValue(new Error('secret-token'))
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(state.saved.last_signup_error).toContain('historial')
    expect(JSON.stringify(state.saved)).not.toContain('secret-token')
  })
  it('no repite sync reservado y conserva las reservas', async () => {
    state.reserved = false
    state.existing = { phone_number_id: '123', contacts_sync_requested_at: 'before', history_sync_requested_at: 'before' }
    await POST(request())
    expect(mocks.sync).not.toHaveBeenCalled()
  })
  it('embedded queda pendiente sin sincronizar', async () => {
    const response = await POST(request({ ...body, event: 'FINISH' }))
    expect(await response.json()).toMatchObject({ registered: false, registration_skipped: true })
    expect(mocks.sync).not.toHaveBeenCalled()
  })
})
