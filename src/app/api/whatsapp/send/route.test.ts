import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Tests for the `contact_id` send path (issue #296): sending an approved
// template to a single contact from the Contact detail view. The route must
// find-or-create the contact's conversation server-side, then run the normal
// send + persistence path — no inbound message required to bootstrap a thread.
// ---------------------------------------------------------------------------

// Records of what the route wrote, so we can assert the right rows landed.
const conversationInserts: Array<Record<string, unknown>> = []
const messageInserts: Array<Record<string, unknown>> = []
// Filtros (.eq/.or) de las búsquedas en `conversations`, para comprobar
// que el hilo se busca por contacto Y línea.
const conversationFilters: unknown[][] = []
let conversationLookupError: { message: string } | null = null
let noLines = false

const LINE_A = {
  id: 'line-A', account_id: 'acct-1', phone_number_id: 'PNID-A',
  access_token: 'enc-token', is_primary: true, area: null,
}
const LINE_B = {
  id: 'line-B', account_id: 'acct-1', phone_number_id: 'PNID-B',
  access_token: 'enc-token', is_primary: false, area: 'posventa',
}

// Toggles for the per-test scenario.
let existingConversation: Record<string, unknown> | null = null
let contactRow: Record<string, unknown> | null = null
// A conversation created during the request becomes retrievable by id —
// the shared send core re-loads the conversation (with its contact) from
// just the id, so the mock must model insert-then-select-by-id.
let createdConversation: Record<string, unknown> | null = null

const CONTACT = {
  id: 'contact-1',
  account_id: 'acct-1',
  phone: '+15551234567',
}

// Chainable Supabase mock. A fresh builder per `.from()` call tracks whether
// `.insert()` ran so the terminal resolves to the inserted row for creates
// and the canned select row otherwise.
function makeSupabaseMock() {
  function builder(table: string) {
    let didInsert = false
    let eqId: string | null = null

    const selectResult = () => {
      switch (table) {
        case 'profiles':
          return { data: { account_id: 'acct-1' }, error: null }
        case 'contacts':
          return { data: contactRow, error: null }
        case 'conversations':
          // Once created this request, a by-id reload returns it (with
          // its contact); otherwise fall back to the canned existing row.
          return {
            data: createdConversation ?? existingConversation,
            error: conversationLookupError,
          }
        case 'whatsapp_config':
          if (noLines) return { data: null, error: null }
          if (eqId === 'line-B') return { data: LINE_B, error: null }
          if (eqId && eqId !== 'line-A') return { data: null, error: null }
          return { data: LINE_A, error: null }
        case 'message_templates':
          return { data: null, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const insertResult = () => {
      switch (table) {
        case 'conversations':
          return {
            data: {
              id: 'conv-new',
              account_id: 'acct-1',
              contact_id: 'contact-1',
              contact: CONTACT,
            },
            error: null,
          }
        case 'messages':
          return { data: { id: 'msg-1' }, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const terminal = () =>
      Promise.resolve(didInsert ? insertResult() : selectResult())

    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'in', 'order', 'limit', 'update', 'delete']) {
      b[m] = vi.fn(chain)
    }
    b.eq = vi.fn((col: string, val: string) => {
      if (col === 'id') eqId = val
      if (table === 'conversations') conversationFilters.push(['eq', col, val])
      return b
    })
    b.or = vi.fn((expr: string) => {
      if (table === 'conversations') conversationFilters.push(['or', expr])
      return b
    })
    b.insert = vi.fn((payload: Record<string, unknown>) => {
      didInsert = true
      if (table === 'conversations') {
        conversationInserts.push(payload)
        createdConversation = {
          id: 'conv-new',
          account_id: 'acct-1',
          contact_id: 'contact-1',
          contact: CONTACT,
        }
      }
      if (table === 'messages') messageInserts.push(payload)
      return b
    })
    b.single = vi.fn(terminal)
    b.maybeSingle = vi.fn(terminal)
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve(didInsert ? insertResult() : selectResult())
    return b
  }

  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['update', 'eq', 'select']) b[m] = vi.fn(chain)
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: null, error: null })
      return b
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
  encrypt: vi.fn(() => 'enc-token'),
  isLegacyFormat: vi.fn(() => false),
}))

const { sendTemplateMessage } = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid-1' })),
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage,
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
}))

import { POST } from './route'

function postContactTemplate(overrides: Record<string, unknown> = {}) {
  return POST(
    new Request('http://localhost/api/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact_id: 'contact-1',
        message_type: 'template',
        template_name: 'order_update',
        template_language: 'en_US',
        template_message_params: { body: ['Acme', '#1234'] },
        template_params: ['Acme', '#1234'],
        ...overrides,
      }),
    }),
  )
}

describe('POST /api/whatsapp/send — contact_id template path', () => {
  beforeEach(() => {
    conversationInserts.length = 0
    messageInserts.length = 0
    conversationFilters.length = 0
    conversationLookupError = null
    noLines = false
    existingConversation = null
    createdConversation = null
    contactRow = CONTACT
    supabaseMock = makeSupabaseMock()
    sendTemplateMessage.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates a conversation for a contact with none, then sends the template', async () => {
    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.whatsapp_message_id).toBe('wamid-1')

    // A conversation was created for this contact.
    expect(conversationInserts).toHaveLength(1)
    expect(conversationInserts[0]).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'contact-1',
    })

    // The template was sent to the contact's number.
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1)
    const args = (sendTemplateMessage.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >
    // Meta wants the bare E.164 digits — sanitizePhoneForMeta strips the '+'.
    expect(args.to).toBe('15551234567')
    expect(args.templateName).toBe('order_update')

    // The outbound message was persisted under the new conversation.
    expect(messageInserts).toHaveLength(1)
    expect(messageInserts[0]).toMatchObject({
      conversation_id: 'conv-new',
      content_type: 'template',
      template_name: 'order_update',
      sender_type: 'agent',
    })
  })

  it('reuses an existing conversation instead of creating a duplicate', async () => {
    existingConversation = {
      id: 'conv-existing',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      contact: CONTACT,
    }

    const res = await postContactTemplate()
    expect(res.status).toBe(200)

    expect(conversationInserts).toHaveLength(0)
    expect(messageInserts[0]).toMatchObject({ conversation_id: 'conv-existing' })
  })

  it('404s when the contact is not in the caller account', async () => {
    contactRow = null

    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toMatch(/contact not found/i)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('400s when neither conversation_id nor contact_id is provided', async () => {
    const res = await POST(
      new Request('http://localhost/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_type: 'template', template_name: 'x' }),
      }),
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /api/whatsapp/send — contact_id con varias líneas', () => {
  beforeEach(() => {
    conversationInserts.length = 0
    messageInserts.length = 0
    conversationFilters.length = 0
    conversationLookupError = null
    existingConversation = null
    createdConversation = null
    contactRow = CONTACT
    supabaseMock = makeSupabaseMock()
    sendTemplateMessage.mockClear()
  })

  it('con line_id busca el hilo de esa línea y, si existe, no crea un tercero', async () => {
    existingConversation = {
      id: 'conv-B', account_id: 'acct-1', contact_id: 'contact-1', line_id: 'line-B',
      contact: CONTACT,
    }

    const res = await postContactTemplate({ line_id: 'line-B' })
    expect(res.status).toBe(200)

    expect(conversationFilters).toContainEqual(['eq', 'line_id', 'line-B'])
    expect(conversationFilters.some((f) => f[0] === 'or')).toBe(false)
    expect(conversationInserts).toHaveLength(0)
    expect(messageInserts[0]).toMatchObject({ conversation_id: 'conv-B' })
  })

  it('un hilo nuevo nace con line_id y area de la línea', async () => {
    const res = await postContactTemplate({ line_id: 'line-B' })
    expect(res.status).toBe(200)

    expect(conversationInserts).toHaveLength(1)
    expect(conversationInserts[0]).toMatchObject({
      contact_id: 'contact-1',
      line_id: 'line-B',
      area: 'posventa',
    })
  })

  it('sin line_id usa la principal (que también reutiliza hilos antiguos sin línea)', async () => {
    const res = await postContactTemplate()
    expect(res.status).toBe(200)

    expect(conversationFilters).toContainEqual(['or', 'line_id.eq.line-A,line_id.is.null'])
    expect(conversationInserts[0]).toMatchObject({ line_id: 'line-A', area: null })
  })

  it('una line_id que no es de la cuenta da 404 y no crea nada', async () => {
    const res = await postContactTemplate({ line_id: 'line-X' })
    expect(res.status).toBe(404)
    expect(conversationInserts).toHaveLength(0)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })

  it('un error real al buscar el hilo no se toma por "sin hilo": 500 sin crear', async () => {
    conversationLookupError = { message: 'boom' }
    const res = await postContactTemplate()
    expect(res.status).toBe(500)
    expect(conversationInserts).toHaveLength(0)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })
})

describe('POST /api/whatsapp/send — cuenta sin ninguna línea', () => {
  beforeEach(() => {
    conversationInserts.length = 0
    messageInserts.length = 0
    conversationFilters.length = 0
    conversationLookupError = null
    noLines = true
    existingConversation = null
    createdConversation = null
    contactRow = CONTACT
    supabaseMock = makeSupabaseMock()
    sendTemplateMessage.mockClear()
  })

  afterEach(() => {
    noLines = false
  })

  it('abre el hilo como antes (sin line_id) y deja decidir al núcleo de envío, sin 400 previo', async () => {
    const res = await postContactTemplate()
    const json = await res.json()

    // El hilo se creó: la ruta ya no corta antes de abrirlo.
    expect(conversationInserts).toHaveLength(1)
    expect(conversationInserts[0]).toMatchObject({ account_id: 'acct-1', contact_id: 'contact-1' })
    expect(conversationInserts[0]).not.toHaveProperty('line_id')
    // El núcleo es quien responde (aquí, el error de siempre al no haber línea).
    expect(res.status).toBe(400)
    expect(json.error).toMatch(/WhatsApp not configured/)
    expect(sendTemplateMessage).not.toHaveBeenCalled()
  })
})
