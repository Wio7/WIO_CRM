import { beforeEach, describe, expect, it, vi } from 'vitest'

// El 23/10/2026 producción salió de una rama sin el modo equipo y Bryce y
// Eric pasaron a ser atendidos como clientes. Esto falla si el webhook deja
// de preguntarle primero a atenderEquipo.
const state = vi.hoisted(() => ({ tareas: [] as Promise<unknown>[], tablas: [] as string[] }))
const mocks = vi.hoisted(() => ({ atenderEquipo: vi.fn(), findExistingContact: vi.fn() }))

vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (fn: () => Promise<unknown>) => { state.tareas.push(fn()) },
}))
vi.mock('@/lib/whatsapp/webhook-signature', () => ({ verifyMetaWebhookSignature: () => true }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token', encrypt: (t: string) => t, isLegacyFormat: () => false }))
vi.mock('@/lib/asistentes-whatsapp/equipo', () => ({ atenderEquipo: mocks.atenderEquipo }))
vi.mock('@/lib/contacts/dedupe', () => ({ findExistingContact: mocks.findExistingContact, isUniqueViolation: () => false }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (tabla: string) => {
  state.tablas.push(tabla)
  const b = { select: () => b, eq: () => (tabla === 'whatsapp_config'
    ? Promise.resolve({ data: [{ account_id: 'golden', user_id: 'admin', access_token: 'x' }], error: null })
    : b) }
  return b
} }) }))

const { POST } = await import('./route')

const mensaje = { id: 'wamid.1', from: '51936992808', type: 'text', timestamp: '1', text: { body: 'hola' } }
const entrada = () => new Request('http://localhost/api/whatsapp/webhook', {
  method: 'POST',
  body: JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'pn' },
    contacts: [{ profile: { name: 'Erick' }, wa_id: '51936992808' }],
    messages: [mensaje],
  } }] }] }),
})

beforeEach(() => {
  vi.clearAllMocks()
  state.tareas = []
  state.tablas = []
})

describe('webhook de WhatsApp y el equipo de Golden', () => {
  it('el mensaje de alguien del equipo lo atiende su asistente, no entra como cliente', async () => {
    mocks.atenderEquipo.mockResolvedValue(true)
    expect((await POST(entrada())).status).toBe(200)
    await Promise.all(state.tareas)
    expect(mocks.atenderEquipo).toHaveBeenCalledWith(expect.objectContaining({
      mensaje: expect.objectContaining({ from: '51936992808' }), accountId: 'golden', phoneNumberId: 'pn',
    }))
    expect(mocks.findExistingContact).not.toHaveBeenCalled()
    expect(state.tablas).toEqual(['whatsapp_config'])
  })
})
