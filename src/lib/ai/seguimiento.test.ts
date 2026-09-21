import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  notifyConversation: vi.fn(),
  catalogoDeGolden: vi.fn(),
  state: {
    cuentas: [{ id: 'acct-1', ai_follows_up: true }] as unknown[],
    cuenta: { owner_user_id: 'owner-1', ai_books_appointments: false } as Record<string, unknown> | null,
    convs: [] as Record<string, unknown>[],
    mensajes: [] as { sender_type: string; created_at: string }[],
    citas: 0,
    updates: [] as Record<string, unknown>[],
    conDetalle: { assigned_agent_id: 'agent-9', contact: { name: 'Olinda', phone: null } } as Record<string, unknown>,
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('@/lib/push/send', () => ({ notifyConversation: h.notifyConversation }))
vi.mock('@/lib/golden/catalogo', () => ({
  catalogoDeGolden: h.catalogoDeGolden,
  catalogoEnTexto: () => 'catálogo',
  sinCatalogoPegado: (p: string | null) => p,
}))
vi.mock('@/lib/agenda/slots', () => ({
  diasLibres: async () => [],
  equipoQuePuedeAgendar: async () => [],
}))
vi.mock('@/lib/agenda/reservar', () => ({ agendaEnTexto: () => '' }))

/** Un cliente de Supabase de mentira, con sólo lo que usa el módulo. */
function db() {
  return {
    from(tabla: string) {
      if (tabla === 'accounts') {
        // Dos usos con la misma forma hasta `.eq()`: la lista de cuentas
        // se espera ahí mismo, y la cuenta suelta sigue a `.maybeSingle()`.
        // Por eso `.eq()` devuelve algo que es a la vez promesa y eslabón.
        const trasEq = {
          then: (resolver: (v: unknown) => void) => resolver({ data: h.state.cuentas, error: null }),
          maybeSingle: async () => ({ data: h.state.cuenta, error: null }),
        }
        return { select: () => ({ eq: () => trasEq }) }
      }
      if (tabla === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                gte: () => ({
                  lt: () => ({
                    limit: async () => ({ data: h.state.convs, error: null }),
                  }),
                }),
              }),
              maybeSingle: async () => ({ data: h.state.conDetalle, error: null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            h.state.updates.push(payload)
            return { eq: async () => ({ error: null }) }
          },
        }
      }
      if (tabla === 'messages') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: h.state.mensajes, error: null }),
              }),
            }),
          }),
        }
      }
      if (tabla === 'appointments') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                gte: async () => ({ count: h.state.citas, error: null }),
              }),
            }),
          }),
        }
      }
      // contacts
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: 'Olinda' }, error: null }) }) }),
      }
    },
  } as never
}

import { seguimientosPendientes } from './seguimiento'

const haceMinutos = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

/** Una conversación donde el cliente habló hace `m` minutos y luego contestamos. */
function calladaDesde(m: number, followup_count = 0) {
  h.state.convs = [
    { id: 'conv-1', account_id: 'acct-1', contact_id: 'contact-1', followup_count, followup_last_at: null },
  ]
  h.state.mensajes = [
    { sender_type: 'bot', created_at: haceMinutos(m - 1) },
    { sender_type: 'customer', created_at: haceMinutos(m) },
  ]
}

beforeEach(() => {
  // Mediodía en Lima: dentro de la franja en la que se puede escribir.
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-22T17:00:00.000Z'))
  h.state.cuentas = [{ id: 'acct-1', ai_follows_up: true }]
  h.state.cuenta = { owner_user_id: 'owner-1', ai_books_appointments: false }
  h.state.convs = []
  h.state.mensajes = []
  h.state.citas = 0
  h.state.updates = []
  h.loadAiConfig.mockResolvedValue({
    provider: 'openai',
    model: 'm',
    apiKey: 'k',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 5,
    embeddingsApiKey: null,
  })
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: '¿cuánto cuesta?' }])
  h.generateReply.mockResolvedValue({ text: '¿Te cuento las facilidades de pago?', handoff: false, cita: null })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.notifyConversation.mockResolvedValue(undefined)
  h.catalogoDeGolden.mockResolvedValue(null)
})

afterEach(() => vi.useRealTimers())

describe('seguimientosPendientes', () => {
  it('a la hora de silencio le escribe', async () => {
    calladaDesde(65)
    const r = await seguimientosPendientes(db())
    expect(r.escritos).toBe(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: '¿Te cuento las facilidades de pago?' }),
    )
    expect(h.state.updates[0]).toMatchObject({ followup_count: 1 })
  })

  it('a los cuarenta minutos todavía no', async () => {
    calladaDesde(40)
    expect((await seguimientosPendientes(db())).escritos).toBe(0)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('no insiste dos veces por el mismo silencio', async () => {
    calladaDesde(65, 1) // ya se le escribió una vez; el siguiente toque es a las 3 h
    expect((await seguimientosPendientes(db())).escritos).toBe(0)
  })

  it('a las tres horas sí toca el segundo', async () => {
    calladaDesde(190, 1)
    expect((await seguimientosPendientes(db())).escritos).toBe(1)
    expect(h.state.updates[0]).toMatchObject({ followup_count: 2 })
  })

  it('si el último mensaje es del cliente, no es seguimiento: le toca contestar a la IA', async () => {
    h.state.convs = [
      { id: 'conv-1', account_id: 'acct-1', contact_id: 'contact-1', followup_count: 0, followup_last_at: null },
    ]
    h.state.mensajes = [{ sender_type: 'customer', created_at: haceMinutos(70) }]
    expect((await seguimientosPendientes(db())).escritos).toBe(0)
  })

  it('a quien nunca escribió no se le persigue', async () => {
    h.state.convs = [
      { id: 'conv-1', account_id: 'acct-1', contact_id: 'contact-1', followup_count: 0, followup_last_at: null },
    ]
    h.state.mensajes = [{ sender_type: 'agent', created_at: haceMinutos(300) }]
    expect((await seguimientosPendientes(db())).escritos).toBe(0)
  })

  it('con cita agendada se deja en paz: ya hizo lo que queríamos', async () => {
    calladaDesde(400, 2)
    h.state.citas = 1
    expect((await seguimientosPendientes(db())).escritos).toBe(0)
  })

  it('al tercer toque le suena el celular al asesor', async () => {
    calladaDesde(400, 2)
    const r = await seguimientosPendientes(db())
    expect(r.escritos).toBe(1)
    expect(r.avisados).toBe(1)
    expect(h.notifyConversation.mock.calls[0][1].body).toMatch(/Olinda/)
  })

  it('en el primero no se molesta a nadie', async () => {
    calladaDesde(65)
    expect((await seguimientosPendientes(db())).avisados).toBe(0)
    expect(h.notifyConversation).not.toHaveBeenCalled()
  })

  it('de madrugada no se escribe a nadie', async () => {
    vi.setSystemTime(new Date('2026-09-22T08:00:00.000Z')) // 03:00 en Lima
    calladaDesde(400, 2)
    const r = await seguimientosPendientes(db())
    expect(r.motivo).toBe('fuera de hora')
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('con el interruptor apagado no pasa nada', async () => {
    h.state.cuentas = []
    calladaDesde(400, 2)
    expect((await seguimientosPendientes(db())).escritos).toBe(0)
  })

  it('un toque recién dado bloquea el siguiente aunque toque por reloj', async () => {
    calladaDesde(400, 2)
    h.state.convs[0].followup_last_at = haceMinutos(10)
    expect((await seguimientosPendientes(db())).escritos).toBe(0)
  })

  it('se apunta el toque aunque el envío falle, para no repetirlo en bucle', async () => {
    calladaDesde(65)
    h.engineSendText.mockRejectedValue(new Error('meta caída'))
    const r = await seguimientosPendientes(db())
    expect(r.escritos).toBe(0)
    expect(h.state.updates[0]).toMatchObject({ followup_count: 1 })
  })
})
