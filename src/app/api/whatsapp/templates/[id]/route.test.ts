import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeDb } from '@/lib/test-support/fake-db'
import {
  ACC,
  FOREIGN_LINE,
  LINE_A,
  LINE_B,
  line,
  routeClient,
} from '@/lib/test-support/line-route-fixtures'

let db: FakeDb
const editMessageTemplate = vi.fn()
const deleteMessageTemplate = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => routeClient(db)),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => `dec:${s}` }))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  editMessageTemplate: (...a: unknown[]) => editMessageTemplate(...a),
  deleteMessageTemplate: (...a: unknown[]) => deleteMessageTemplate(...a),
}))
vi.mock('@/lib/whatsapp/template-header-handle', () => ({
  ensureImageHeaderHandle: vi.fn(async () => undefined),
}))

import { DELETE, PATCH } from './route'

const TPL_ID = '11111111-1111-4111-8111-111111111111'
const ctx = { params: Promise.resolve({ id: TPL_ID }) }
const PAYLOAD = { name: 'promo', category: 'Marketing', language: 'es', body_text: 'Hola' }

const template = () => ({
  id: TPL_ID,
  account_id: ACC,
  name: 'promo',
  language: 'es',
  status: 'APPROVED',
  meta_template_id: 'meta-1',
})

function seed(lines: unknown[]) {
  db = new FakeDb({
    whatsapp_config: lines as never,
    message_templates: [template()] as never,
  })
}

const patch = (extra: Record<string, unknown> = {}) =>
  PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ ...PAYLOAD, ...extra }) }), ctx)
const del = (query = '') =>
  DELETE(new Request(`http://x/api/whatsapp/templates/${TPL_ID}${query}`, { method: 'DELETE' }), ctx)

beforeEach(() => {
  delete process.env.WHATSAPP_TEMPLATES_DRY_RUN
  editMessageTemplate.mockReset().mockResolvedValue({})
  deleteMessageTemplate.mockReset().mockResolvedValue(undefined)
})

describe('templates/[id] PATCH con líneas', () => {
  it('una línea: edita con su token (sin cambios)', async () => {
    seed([LINE_A])
    expect((await patch()).status).toBe(200)
    expect(editMessageTemplate.mock.calls[0][0]).toMatchObject({ accessToken: 'dec:enc-a' })
  })

  it('dos líneas con line_id: usa el token de esa línea', async () => {
    seed([LINE_A, LINE_B])
    expect((await patch({ line_id: 'line-b' })).status).toBe(200)
    expect(editMessageTemplate.mock.calls[0][0]).toMatchObject({ accessToken: 'dec:enc-b' })
  })

  it('dos líneas sin line_id: la principal', async () => {
    seed([LINE_B, LINE_A])
    await patch()
    expect(editMessageTemplate.mock.calls[0][0]).toMatchObject({ accessToken: 'dec:enc-a' })
  })

  it('line_id de otra cuenta: 404 sin llamar a Meta', async () => {
    seed([LINE_A, FOREIGN_LINE])
    expect((await patch({ line_id: 'line-x' })).status).toBe(404)
    expect(editMessageTemplate).not.toHaveBeenCalled()
  })

  it('línea desconectada: error claro sin llamar a Meta', async () => {
    seed([LINE_A, line({ ...LINE_B, disconnected_at: '2026-11-01T00:00:00Z' })])
    const res = await patch({ line_id: 'line-b' })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain('desconectada')
    expect(editMessageTemplate).not.toHaveBeenCalled()
  })
})

describe('templates/[id] DELETE con líneas', () => {
  it('una línea: borra en su WABA (sin cambios)', async () => {
    seed([LINE_A])
    expect((await del()).status).toBe(200)
    expect(deleteMessageTemplate.mock.calls[0][0]).toMatchObject({
      wabaId: 'waba-a',
      accessToken: 'dec:enc-a',
    })
  })

  it('dos líneas con ?line_id: usa la WABA de esa línea', async () => {
    seed([LINE_A, LINE_B])
    expect((await del('?line_id=line-b')).status).toBe(200)
    expect(deleteMessageTemplate.mock.calls[0][0]).toMatchObject({
      wabaId: 'waba-b',
      accessToken: 'dec:enc-b',
    })
  })

  it('dos líneas sin line_id: la principal', async () => {
    seed([LINE_B, LINE_A])
    await del()
    expect(deleteMessageTemplate.mock.calls[0][0]).toMatchObject({ wabaId: 'waba-a' })
  })

  it('line_id de otra cuenta: 404 sin llamar a Meta ni borrar la fila', async () => {
    seed([LINE_A, FOREIGN_LINE])
    expect((await del('?line_id=line-x')).status).toBe(404)
    expect(deleteMessageTemplate).not.toHaveBeenCalled()
    expect(db.table('message_templates')).toHaveLength(1)
  })

  it('línea desconectada: error claro sin llamar a Meta', async () => {
    seed([LINE_A, line({ ...LINE_B, disconnected_at: '2026-11-01T00:00:00Z' })])
    const res = await del('?line_id=line-b')
    expect(res.status).toBe(503)
    expect(deleteMessageTemplate).not.toHaveBeenCalled()
    expect(db.table('message_templates')).toHaveLength(1)
  })
})
