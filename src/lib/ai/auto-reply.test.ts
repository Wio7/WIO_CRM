import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  reservarCita: vi.fn(),
  diasLibres: vi.fn(),
  equipoQuePuedeAgendar: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    account: null as Record<string, unknown> | null,
    agentMessages: [] as { id: string }[],
    contact: { name: 'Ana', dni: null } as Record<string, unknown> | null,
    balance: null as Record<string, unknown> | null,
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('@/lib/agenda/slots', () => ({
  diasLibres: h.diasLibres,
  equipoQuePuedeAgendar: h.equipoQuePuedeAgendar,
}))
vi.mock('@/lib/agenda/reservar', () => ({
  reservarCita: h.reservarCita,
  esTipoDeCita: (v: unknown) => ['videollamada', 'visita', 'llamada'].includes(v as string),
  agendaEnTexto: (dias: { etiqueta: string }[]) => dias.map((d) => d.etiqueta).join('\n'),
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'accounts') {
        // .select().eq().maybeSingle() → account switches
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({ data: h.state.account, error: null }),
        }
        return chain
      }
      if (table === 'contacts') {
        // .select().eq().maybeSingle() → con quién habla la IA
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: h.state.contact, error: null }),
        }
        return chain
      }
      if (table === 'payment_plan_balances') {
        // .select().eq().maybeSingle() → su saldo, si ya compró
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: h.state.balance, error: null }),
        }
        return chain
      }
      if (table === 'messages') {
        // .select().eq().eq().limit() → agent messages in the thread
        const chain = {
          select: () => chain,
          eq: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.agentMessages, error: null }),
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.account = { ai_replies_until_agent_responds: false }
  h.state.agentMessages = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.reservarCita.mockResolvedValue({ ok: true, cita: { id: 'cita-1' }, asesorId: 'agent-9' })
  h.diasLibres.mockResolvedValue([])
  h.equipoQuePuedeAgendar.mockResolvedValue(['agent-9'])
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('answers an assigned thread while its agent has not written (041)', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    h.state.account = { ai_replies_until_agent_responds: true }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('stands down on an assigned thread once its agent has written (041)', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    h.state.account = { ai_replies_until_agent_responds: true }
    h.state.agentMessages = [{ id: 'msg-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('stands down on an assigned thread when the switch cannot be read', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    h.state.account = null
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('al pasar a un humano apaga la IA, avisa al cliente y no gasta un turno', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toEqual({ ai_autoreply_disabled: true })
    // El traspaso no consume una de las respuestas del tope.
    expect(h.state.rpcCalls).toHaveLength(0)
    // Y sobre todo: el cliente ya no se queda hablando solo.
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText.mock.calls[0][0].text).toMatch(/asesor/i)
  })
})

// ============================================================
// 058: la IA no se apaga sola, y agenda ella misma.
// ============================================================

/** Una cuenta con los dos interruptores de la 058 encendidos. */
const GOLDEN = {
  ai_replies_until_agent_responds: true,
  ai_books_appointments: true,
  ai_stops_only_on_button: true,
}

describe('dispatchInboundToAiReply — sólo el botón la calla (058)', () => {
  it('sigue contestando aunque el asesor ya haya escrito', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    h.state.account = GOLDEN
    h.state.agentMessages = [{ id: 'msg-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
  })

  it('el botón "Yo" sí la calla', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    h.state.account = GOLDEN
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('pedir ayuda humana avisa al asesor pero no apaga la IA ni cambia el mensaje', async () => {
    h.state.account = GOLDEN
    h.generateReply.mockResolvedValue({
      text: 'Te consigo ese dato y te escribo.',
      handoff: true,
    })
    await dispatchInboundToAiReply(ARGS)
    // Nada de `ai_autoreply_disabled`: la IA no se apaga a sí misma.
    expect(h.state.updatePayload).toBeNull()
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Te consigo ese dato y te escribo.' }),
    )
  })

  it('si el modelo no devuelve nada, avisa al cliente y tampoco se apaga', async () => {
    h.state.account = GOLDEN
    h.generateReply.mockResolvedValue({ text: '', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toBeNull()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })
})

describe('dispatchInboundToAiReply — la IA agenda (058)', () => {
  it('reserva la hora que pidió el modelo y manda su mensaje tal cual', async () => {
    h.state.account = GOLDEN
    h.generateReply.mockResolvedValue({
      text: 'Listo, nos vemos el jueves a las 10:30.',
      handoff: false,
      cita: { cuandoIso: '2026-09-24T15:30:00.000Z', tipo: 'visita' },
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.reservarCita).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        contactId: 'contact-1',
        conversationId: 'conv-1',
        cuandoIso: '2026-09-24T15:30:00.000Z',
        tipo: 'visita',
      }),
    )
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Listo, nos vemos el jueves a las 10:30.' }),
    )
  })

  it('un tipo raro no llega a la base: se reserva como videollamada', async () => {
    h.state.account = GOLDEN
    h.generateReply.mockResolvedValue({
      text: 'Hecho.',
      handoff: false,
      cita: { cuandoIso: '2026-09-24T15:30:00.000Z', tipo: 'cafecito' },
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.reservarCita.mock.calls[0][1].tipo).toBe('videollamada')
  })

  it('si la hora ya estaba tomada, no le confirma una cita que no existe', async () => {
    h.state.account = GOLDEN
    h.reservarCita.mockResolvedValue({
      ok: false,
      motivo: 'hora_ocupada',
      dias: [{ etiqueta: 'Mañana', tramos: [{ hora: '11:00' }, { hora: '11:30' }] }],
    })
    h.generateReply.mockResolvedValue({
      text: 'Listo, nos vemos el jueves a las 10:30.',
      handoff: false,
      cita: { cuandoIso: '2026-09-24T15:30:00.000Z', tipo: 'videollamada' },
    })
    await dispatchInboundToAiReply(ARGS)
    const enviado = h.engineSendText.mock.calls[0][0].text as string
    expect(enviado).not.toMatch(/Listo, nos vemos/)
    expect(enviado).toMatch(/Mañana a las 11:00/)
  })

  it('sin el interruptor no se agenda nada, aunque el modelo lo pida', async () => {
    h.state.account = { ai_replies_until_agent_responds: true }
    h.generateReply.mockResolvedValue({
      text: 'Hecho.',
      handoff: false,
      cita: { cuandoIso: '2026-09-24T15:30:00.000Z', tipo: 'visita' },
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.reservarCita).not.toHaveBeenCalled()
  })
})
