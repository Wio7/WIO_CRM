import { beforeEach, describe, expect, it, vi } from 'vitest'

// El 23/10/2026 producción salió de una rama sin el modo equipo y Bryce y
// Eric pasaron a ser atendidos como clientes. Esto falla si el webhook deja
// de preguntarle primero a atenderEquipo.
const state = vi.hoisted(() => ({ tareas: [] as Promise<unknown>[], tablas: [] as string[],
  lineas: null as Record<string, unknown>[] | null, convs: [] as Record<string, unknown>[] }))
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
// Conversaciones en memoria: filtra por eq/is/or y soporta insert, para probar el hilo por línea.
function conversaciones() {
  const filtros: ((r: Record<string, unknown>) => boolean)[] = []
  let fila: Record<string, unknown> | null = null
  const correr = () => {
    if (fila) {
      const nueva = { id: 'conv-' + (state.convs.length + 1), ...fila }
      state.convs.push(nueva)
      return { data: nueva, error: null }
    }
    const hallada = state.convs.find(r => filtros.every(f => f(r)))
    return { data: hallada ?? null, error: hallada ? null : { code: 'PGRST116' } }
  }
  const q: Record<string, unknown> = {
    select: () => q, order: () => q, limit: () => q, update: () => q,
    eq: (k: string, v: unknown) => { filtros.push(r => r[k] === v); return q },
    is: (k: string, v: unknown) => { filtros.push(r => (r[k] ?? null) === v); return q },
    or: (expr: string) => {
      const ors = expr.split(',').map(p => p.split('.'))
      filtros.push(r => ors.some(([k, op, v]) => (op === 'is' ? (r[k] ?? null) === null : r[k] === v)))
      return q
    },
    insert: (row: Record<string, unknown>) => { fila = row; return q },
    single: () => Promise.resolve(correr()),
    maybeSingle: () => Promise.resolve(correr()),
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok),
  }
  return q
}
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: mocks.rpc, from: (tabla: string) => {
  state.tablas.push(tabla)
  if (tabla === 'conversations') return conversaciones()
  const b: Record<string, unknown> = { select: () => b, eq: (k: string, v: unknown) => (tabla === 'whatsapp_config'
    ? Promise.resolve({ data: state.lineas ? state.lineas.filter(l => l[k] === v) : [{ account_id: 'golden', user_id: 'admin', access_token: 'x' }], error: null })
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
  state.lineas = null
  state.convs = []
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

describe('webhook de WhatsApp: un hilo por línea', () => {
  const linea = (id: string, pn: string, area: string | null, primaria: boolean) => ({
    id, account_id: 'cuenta', user_id: 'admin', access_token: 'x', phone_number_id: pn, area, is_primary: primaria,
  })
  const hacia = (pn: string) => new Request('http://localhost/api/whatsapp/webhook', {
    method: 'POST',
    body: JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: pn },
      contacts: [{ profile: { name: 'Erick' }, wa_id: '51936992808' }],
      messages: [{ ...mensaje, id: 'wamid.' + pn }],
    } }] }] }),
  })
  const enviar = async (pn: string) => { expect((await POST(hacia(pn))).status).toBe(200); await Promise.all(state.tareas) }
  beforeEach(() => { mocks.atenderEquipo.mockResolvedValue(false) })

  it('el mismo contacto escribiendo a dos líneas crea dos hilos, cada uno con su línea y área', async () => {
    state.lineas = [linea('A', 'pnA', 'ventas', true), linea('B', 'pnB', 'cobranzas', false)]
    await enviar('pnA')
    await enviar('pnB')
    await enviar('pnB')
    expect(state.convs.map(c => [c.line_id, c.area, c.contact_id])).toEqual([['A', 'ventas', 'contact'], ['B', 'cobranzas', 'contact']])
  })
  it('una cuenta con una sola línea sigue usando un solo hilo, incluso el antiguo sin línea', async () => {
    state.lineas = [linea('A', 'pnA', null, true)]
    state.convs = [{ id: 'vieja', account_id: 'cuenta', contact_id: 'contact', line_id: null }]
    await enviar('pnA')
    await enviar('pnA')
    expect(state.convs).toHaveLength(1)
    expect(state.convs[0].id).toBe('vieja')
  })
  it('una cuenta con una sola línea y sin hilos crea uno solo', async () => {
    state.lineas = [linea('A', 'pnA', null, true)]
    await enviar('pnA')
    await enviar('pnA')
    expect(state.convs.map(c => c.line_id)).toEqual(['A'])
  })
  it('el hilo antiguo sin línea no lo reutiliza una línea secundaria', async () => {
    state.lineas = [linea('A', 'pnA', null, true), linea('B', 'pnB', 'cobranzas', false)]
    state.convs = [{ id: 'vieja', account_id: 'cuenta', contact_id: 'contact', line_id: null }]
    await enviar('pnB')
    expect(state.convs.map(c => c.line_id)).toEqual([null, 'B'])
  })
  it('el eco de la línea B resuelve el hilo con la línea B, nunca el de la A', async () => {
    state.lineas = [linea('A', 'pnA', null, true), linea('B', 'pnB', 'cobranzas', false)]
    const response = await POST(new Request('http://localhost/api/whatsapp/webhook', {
      method: 'POST', body: JSON.stringify({ entry: [{ changes: [{ field: 'smb_message_echoes', value: {
        messaging_product: 'whatsapp', metadata: { phone_number_id: 'pnB', display_phone_number: '51911111111' },
        message_echoes: [{ ...mensaje, from: '51911111111', to: '51922222222' }],
      } }] }] }),
    }))
    expect(response.status).toBe(200)
    await Promise.all(state.tareas)
    expect(mocks.rpc).toHaveBeenCalledWith('coexistence_conversation', expect.objectContaining({ p_line: 'B' }))
  })
})
