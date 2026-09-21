import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateReply, parseGeneration } from './generate'
import { AiError, type AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    embeddingsApiKey: null,
    ...overrides,
  }
}

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('parseGeneration', () => {
  it('returns text with no handoff', () => {
    expect(parseGeneration('Hello there')).toEqual({
      text: 'Hello there',
      handoff: false,
      cita: null,
    })
  })

  it('detects + strips the handoff sentinel', () => {
    expect(parseGeneration('[[HANDOFF]]')).toEqual({ text: '', handoff: true, cita: null })
    expect(parseGeneration('Let me get a human [[HANDOFF]]')).toEqual({
      text: 'Let me get a human',
      handoff: true,
      cita: null,
    })
  })

  // El sello de cita (058). Lo que el cliente ve nunca puede llevarlo.
  it('saca la cita del sello y la quita del texto', () => {
    const r = parseGeneration(
      'Listo, te agendo el jueves a las 10:30. [[AGENDAR:2026-09-24T15:30:00.000Z|videollamada]]',
    )
    expect(r.cita).toEqual({ cuandoIso: '2026-09-24T15:30:00.000Z', tipo: 'videollamada' })
    expect(r.text).toBe('Listo, te agendo el jueves a las 10:30.')
    expect(r.handoff).toBe(false)
  })

  it('sin tipo, la cita es videollamada', () => {
    expect(parseGeneration('Va. [[AGENDAR:2026-09-24T15:30:00.000Z]]').cita).toEqual({
      cuandoIso: '2026-09-24T15:30:00.000Z',
      tipo: 'videollamada',
    })
  })

  it('un sello con fecha inválida no agenda, pero tampoco se le enseña al cliente', () => {
    const r = parseGeneration('Ahí te va. [[AGENDAR:el jueves|visita]]')
    expect(r.cita).toBeNull()
    expect(r.text).toBe('Ahí te va.')
  })

  it('quita todos los sellos si el modelo repite', () => {
    const r = parseGeneration(
      'Uno [[AGENDAR:2026-09-24T15:30:00.000Z|visita]] y dos [[AGENDAR:2026-09-25T15:30:00.000Z|visita]]',
    )
    expect(r.text).toBe('Uno  y dos')
    expect(r.cita?.cuandoIso).toBe('2026-09-24T15:30:00.000Z')
  })

  it('convive con el traspaso', () => {
    const r = parseGeneration(
      'Te agendo y aviso al asesor. [[AGENDAR:2026-09-24T15:30:00.000Z|llamada]][[HANDOFF]]',
    )
    expect(r.handoff).toBe(true)
    expect(r.cita?.tipo).toBe('llamada')
    expect(r.text).toBe('Te agendo y aviso al asesor.')
  })
})

describe('generateReply — OpenAI', () => {
  it('calls the chat completions endpoint and returns the reply', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okResponse({ choices: [{ message: { content: 'Sure — happy to help!' } }] }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res).toEqual({ text: 'Sure — happy to help!', handoff: false, cita: null })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(401, { error: { message: 'Incorrect API key' } }),
      ),
    )

    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('throws on an empty completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })),
    )
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toBeInstanceOf(AiError)
  })
})

describe('generateReply — Anthropic', () => {
  it('calls the messages endpoint with the version header and parses text blocks', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'Hi there!' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    expect(res).toEqual({ text: 'Hi there!', handoff: false, cita: null })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    expect(opts.headers['x-api-key']).toBe('sk-ant-x')
    expect(opts.headers['anthropic-version']).toBeTruthy()
  })

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: '[[HANDOFF]]' }] }),
      ),
    )
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want to speak to a person' }],
    })
    expect(res.handoff).toBe(true)
    expect(res.text).toBe('')
  })

  it('drops a leading assistant turn so the payload starts on the customer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages).toHaveLength(1)
  })
})
