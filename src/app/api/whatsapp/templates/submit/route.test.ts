import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeDb } from '@/lib/test-support/fake-db'
import {
  FOREIGN_LINE,
  LINE_A,
  LINE_B,
  line,
  routeClient,
} from '@/lib/test-support/line-route-fixtures'

let db: FakeDb
const submitMessageTemplate = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => routeClient(db)),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => `dec:${s}` }))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  submitMessageTemplate: (...a: unknown[]) => submitMessageTemplate(...a),
}))
vi.mock('@/lib/whatsapp/template-header-handle', () => ({
  ensureImageHeaderHandle: vi.fn(async () => undefined),
}))

import { POST } from './route'

const PAYLOAD = { name: 'promo', category: 'Marketing', language: 'es', body_text: 'Hola' }

function post(extra: Record<string, unknown> = {}) {
  return POST(
    new Request('http://x/api/whatsapp/templates/submit', {
      method: 'POST',
      body: JSON.stringify({ ...PAYLOAD, ...extra }),
    }),
  )
}

beforeEach(() => {
  delete process.env.WHATSAPP_TEMPLATES_DRY_RUN
  submitMessageTemplate.mockReset()
  submitMessageTemplate.mockResolvedValue({ id: 'meta-1', status: 'PENDING' })
})

describe('templates/submit con líneas', () => {
  it('cuenta con una línea: se envía por esa WABA (sin cambios)', async () => {
    db = new FakeDb({ whatsapp_config: [LINE_A] })
    const res = await post()
    expect(res.status).toBe(200)
    expect(submitMessageTemplate.mock.calls[0][0]).toMatchObject({
      wabaId: 'waba-a',
      accessToken: 'dec:enc-a',
    })
  })

  it('dos líneas con line_id: usa la WABA y el token de esa línea', async () => {
    db = new FakeDb({ whatsapp_config: [LINE_A, LINE_B] })
    const res = await post({ line_id: 'line-b' })
    expect(res.status).toBe(200)
    expect(submitMessageTemplate.mock.calls[0][0]).toMatchObject({
      wabaId: 'waba-b',
      accessToken: 'dec:enc-b',
    })
  })

  it('dos líneas sin line_id: usa la principal', async () => {
    db = new FakeDb({ whatsapp_config: [LINE_B, LINE_A] })
    const res = await post()
    expect(res.status).toBe(200)
    expect(submitMessageTemplate.mock.calls[0][0]).toMatchObject({ wabaId: 'waba-a' })
  })

  it('line_id de otra cuenta: 404 y no llama a Meta', async () => {
    db = new FakeDb({ whatsapp_config: [LINE_A, FOREIGN_LINE] })
    const res = await post({ line_id: 'line-x' })
    expect(res.status).toBe(404)
    expect(submitMessageTemplate).not.toHaveBeenCalled()
  })

  it('línea desconectada: error claro y no llama a Meta', async () => {
    db = new FakeDb({
      whatsapp_config: [LINE_A, line({ ...LINE_B, disconnected_at: '2026-11-01T00:00:00Z' })],
    })
    const res = await post({ line_id: 'line-b' })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain('desconectada')
    expect(submitMessageTemplate).not.toHaveBeenCalled()
  })

  it('sin ninguna línea: mismo error de siempre', async () => {
    db = new FakeDb({ whatsapp_config: [] })
    const res = await post()
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('WhatsApp not configured')
  })
})
