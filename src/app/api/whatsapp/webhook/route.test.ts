import { beforeEach, describe, expect, it, vi } from 'vitest'

// El 23/10/2026 producción salió de una rama sin el modo equipo y Bryce y
// Eric pasaron a ser atendidos como clientes. Esto falla si el webhook deja
// de preguntarle primero a atenderEquipo.
const state = vi.hoisted(() => ({ tareas: [] as Promise<unknown>[], tablas: [] as string[] }))
const mocks = vi.hoisted(() => ({ atenderEquipo: vi.fn(), findExistingContact: vi.fn(), rpc: vi.fn(),
  ai: vi.fn(), flows: vi.fn(), automation: vi.fn(), push: vi.fn(), dispatch: vi.fn() }))

vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (fn: () => Promise<unknown>) => { state.tareas.push(fn()) },
}))
vi.mock('@/lib/whatsapp/webhook-signature', () => ({ verifyMetaWebhookSignature: () => true }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token', encrypt: (t: string) => t, isLegacyFormat: () => false }))
vi.mock('@/lib/asistentes-whatsapp/equipo', () => ({ atenderEquipo: mocks.atenderEquipo }))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: mocks.ai }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: mocks.flows }))
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: mocks.automation }))
vi.mock('@/lib/push/send', () => ({ notifyConversation: mocks.push }))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: mocks.dispatch }))
vi.mock('@/lib/contacts/dedupe', () => ({ findExistingContact: mocks.findExistingContact, isUniqueViolation: () => false }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: mocks.rpc, from: (tabla: string) => {
  state.tablas.push(tabla)
  const b = { select: () => b, eq: () => (tabla === 'whatsapp_config'
    ? Promise.resolve({ data: [{ account_id: 'golden', user_id: 'admin', access_token: 'x' }], error: null })
    : b), maybeSingle: () => Promise.resolve({ data: { id: 'contact', phone: '+51 922 222 222', name: 'Nombre CRM' }, error: null }) }
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
  mocks.rpc.mockImplementation(async (name: string) => ({ data: name === 'coexistence_conversation' ? { id: 'conversation' } : null, error: null }))
  mocks.findExistingContact.mockResolvedValue({ id: 'contact', phone: '51922222222', name: 'Nombre CRM' })
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
  it('eco del teléfono: usa el tenant y persiste sin entrar a equipo, IA ni avisos', async () => {
    const response = await POST(new Request('http://localhost/api/whatsapp/webhook', {
      method: 'POST', body: JSON.stringify({ entry: [{ changes: [{ field: 'smb_message_echoes', value: {
        messaging_product: 'whatsapp', metadata: { phone_number_id: 'pn', display_phone_number: '51911111111' },
        message_echoes: [{ ...mensaje, from: '51911111111', to: '51922222222' }],
      } }] }] }),
    }))
    expect(response.status).toBe(200)
    await Promise.all(state.tareas)
    expect(mocks.rpc).toHaveBeenCalledWith('coexistence_insert_messages', expect.objectContaining({
      p_account: 'golden', p_conversation: 'conversation', p_rows: [expect.objectContaining({ sender_type: 'agent', status: 'sent', source: 'phone_app' })],
    }))
    for (const spy of [mocks.atenderEquipo, mocks.ai, mocks.flows, mocks.automation, mocks.push, mocks.dispatch]) expect(spy).not.toHaveBeenCalled()
    expect(state.tablas).toEqual(['whatsapp_config', 'contacts'])
  })
  it('campos desconocidos no procesan siquiera un value con forma de mensaje', async () => {
    const request = entrada()
    const payload = await request.json()
    payload.entry[0].changes[0].field = 'future_field'
    await POST(new Request(request.url, { method: 'POST', body: JSON.stringify(payload) }))
    await Promise.all(state.tareas)
    expect(state.tablas).toEqual([])
    expect(mocks.atenderEquipo).not.toHaveBeenCalled()
  })
})
