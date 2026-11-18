import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sendTextMessage } = vi.hoisted(() => ({
  sendTextMessage: vi.fn(async (..._a: unknown[]) => ({ messageId: 'w' })),
}))

const LINES = [
  { id: 'line-B', phone_number_id: 'PNID-B', access_token: 'tok-B', is_primary: false },
  { id: 'line-A', phone_number_id: 'PNID-A', access_token: 'tok-A', is_primary: true },
]

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: async () => ({
      data: [
        {
          account_id: 'acct-1', user_id: 'u1', name: 'Ana', phone: '+51999111222',
          last_inbound_at: new Date().toISOString(),
        },
      ],
      error: null,
    }),
    from() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b
      b.maybeSingle = () =>
        Promise.resolve({
          data: [...LINES].sort((x, y) => Number(y.is_primary) - Number(x.is_primary))[0],
          error: null,
        })
      return b
    },
  }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn((v: string) => `plain:${v}`) }))
vi.mock('@/lib/whatsapp/meta-api', () => ({ sendTextMessage, sendTemplateMessage: vi.fn() }))
vi.mock('@/lib/asistentes-whatsapp/caja', () => ({
  comoLaPersona: vi.fn(async () => ({ boxes: [{ inCents: 100, outCents: 50 }] })),
}))
vi.mock('@/lib/asistentes-whatsapp/texto', () => ({
  MARCA_CAJA: 'Caja',
  hoyEnLima: () => '2026-11-18',
  recortar: (s: string) => s,
  resumenDelDia: () => 'resumen',
  soles: (n: number) => String(n),
}))

import { GET } from './route'

describe('GET /api/caja/resumen-whatsapp — línea', () => {
  beforeEach(() => {
    sendTextMessage.mockClear()
    process.env.CRON_SECRET = 'secret'
  })

  it('con dos líneas manda por la principal', async () => {
    const res = await GET(
      new Request('http://localhost/api/caja/resumen-whatsapp', {
        headers: { authorization: 'Bearer secret' },
      }),
    )
    expect(res.status).toBe(200)
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: 'PNID-A', accessToken: 'plain:tok-A' }),
    )
  })
})
