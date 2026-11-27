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

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => routeClient(db)),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => `dec:${s}` }))

import { POST } from './route'

const fetchMock = vi.fn()

function sync(query = '') {
  return POST(new Request(`http://x/api/whatsapp/templates/sync${query}`, { method: 'POST' }))
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) })
  vi.stubGlobal('fetch', fetchMock)
})

describe('templates/sync con líneas', () => {
  it('cuenta con una línea: consulta su WABA (sin cambios)', async () => {
    db = new FakeDb({ whatsapp_config: [LINE_A] })
    const res = await sync()
    expect(res.status).toBe(200)
    expect(fetchMock.mock.calls[0][0]).toContain('/waba-a/message_templates')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer dec:enc-a')
  })

  it('dos líneas con line_id: consulta la WABA de esa línea', async () => {
    db = new FakeDb({ whatsapp_config: [LINE_A, LINE_B] })
    const res = await sync('?line_id=line-b')
    expect(res.status).toBe(200)
    expect(fetchMock.mock.calls[0][0]).toContain('/waba-b/message_templates')
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer dec:enc-b')
  })

  it('dos líneas sin line_id: usa la principal', async () => {
    db = new FakeDb({ whatsapp_config: [LINE_B, LINE_A] })
    await sync()
    expect(fetchMock.mock.calls[0][0]).toContain('/waba-a/message_templates')
  })

  it('line_id de otra cuenta: 404 sin llamar a Meta', async () => {
    db = new FakeDb({ whatsapp_config: [LINE_A, FOREIGN_LINE] })
    const res = await sync('?line_id=line-x')
    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('línea desconectada: error claro sin llamar a Meta', async () => {
    db = new FakeDb({
      whatsapp_config: [LINE_A, line({ ...LINE_B, disconnected_at: '2026-11-01T00:00:00Z' })],
    })
    const res = await sync('?line_id=line-b')
    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain('desconectada')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
