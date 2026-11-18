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
const sendTemplateMessage = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => routeClient(db)),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => `dec:${s}` }))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: (...a: unknown[]) => sendTemplateMessage(...a),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response('limit', { status: 429 }),
  RATE_LIMITS: { broadcast: {} },
}))

import { POST } from './route'

function post(extra: Record<string, unknown> = {}) {
  return POST(
    new Request('http://x/api/whatsapp/broadcast', {
      method: 'POST',
      body: JSON.stringify({
        recipients: [{ phone: '+51999111222', params: ['Ana'] }],
        template_name: 'promo',
        template_language: 'es',
        ...extra,
      }),
    }),
  )
}

beforeEach(() => {
  sendTemplateMessage.mockReset().mockResolvedValue({ messageId: 'wamid-1' })
})

describe('whatsapp/broadcast con líneas', () => {
  it('una línea: envía por su número (sin cambios)', async () => {
    db = new FakeDb({ whatsapp_config: [LINE_A] })
    const res = await post()
    expect((await res.json()).sent).toBe(1)
    expect(sendTemplateMessage.mock.calls[0][0]).toMatchObject({
      phoneNumberId: 'pn-a',
      accessToken: 'dec:enc-a',
    })
  })

  it('dos líneas con line_id: toda la difusión sale por esa línea', async () => {
    db = new FakeDb({ whatsapp_config: [LINE_A, LINE_B] })
    const res = await post({ line_id: 'line-b' })
    expect((await res.json()).sent).toBe(1)
    expect(sendTemplateMessage.mock.calls[0][0]).toMatchObject({
      phoneNumberId: 'pn-b',
      accessToken: 'dec:enc-b',
    })
  })

  it('dos líneas sin line_id: usa la principal', async () => {
    db = new FakeDb({ whatsapp_config: [LINE_B, LINE_A] })
    await post()
    expect(sendTemplateMessage.mock.calls[0][0]).toMatchObject({ phoneNumberId: 'pn-a' })
  })

  it('line_id de otra cuenta: 404 sin enviar nada', async () => {
    db = new FakeDb({ whatsapp_config: [LINE_A, FOREIGN_LINE] })
    const res = await post({ line_id: 'line-x' })
    expect(res.status).toBe(404)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('línea desconectada: error claro sin enviar nada', async () => {
    db = new FakeDb({
      whatsapp_config: [LINE_A, line({ ...LINE_B, disconnected_at: '2026-11-01T00:00:00Z' })],
    })
    const res = await post({ line_id: 'line-b' })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain('desconectada')
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('sin ninguna línea: mismo error de siempre', async () => {
    db = new FakeDb({ whatsapp_config: [] })
    const res = await post()
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('WhatsApp not configured')
  })
})
