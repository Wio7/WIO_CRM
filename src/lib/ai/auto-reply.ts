import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import { notifyConversation } from '@/lib/push/send'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread) — unless the
 *     account lets the AI cover until the agent's first message (041)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (
      conv.assigned_agent_id &&
      !(await aiCoversAssignedThread(db, accountId, conversationId))
    ) {
      return // a human owns this thread
    }
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Con quién está hablando: si ya compró, la conversación es otra.
    const ficha = await fichaDelContacto(db, contactId)

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: [config.systemPrompt, ficha].filter(Boolean).join('\n\n'),
      mode: 'auto_reply',
      knowledge,
    })

    const { text, handoff } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    if (handoff || !text) {
      // El modelo no puede (o no debe) seguir. Se apaga la IA en este
      // hilo, PERO no se deja a nadie a oscuras: al cliente se le dice
      // que un asesor le responde, y al asesor le suena el celular. Antes
      // esto era silencio en los dos lados, y el cliente se quedaba
      // escribiendo "¿hola?" sin que nadie apareciera.
      await db
        .from('conversations')
        .update({ ai_autoreply_disabled: true })
        .eq('id', conversationId)
      await avisarQueSigueUnHumano(db, {
        accountId,
        conversationId,
        contactId,
        configOwnerUserId,
      })
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr || claimed !== true) return

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

/**
 * Lo que la IA necesita saber de esta persona para no tratar igual al que
 * ya compró que al que recién pregunta: nombre, si tiene plan de cuotas,
 * cuánto debe y cuándo vence lo próximo. Sale de la misma vista que ve el
 * asesor (`payment_plan_balances`), así que nunca se contradicen.
 */
async function fichaDelContacto(
  db: ReturnType<typeof supabaseAdmin>,
  contactId: string,
): Promise<string> {
  const { data: contacto } = await db
    .from('contacts')
    .select('name, dni')
    .eq('id', contactId)
    .maybeSingle()
  if (!contacto) return ''

  const nombre = (contacto.name ?? '').trim()
  const partes: string[] = ['Con quién estás hablando:']
  if (nombre) partes.push(`- Se llama ${nombre}. Úsalo.`)

  const { data: saldo } = await db
    .from('payment_plan_balances')
    .select('currency, pending_amount, overdue_count, next_due_date')
    .eq('contact_id', contactId)
    .maybeSingle()

  if (saldo) {
    const moneda = saldo.currency === 'PEN' ? 'S/' : String(saldo.currency ?? '')
    partes.push(
      `- YA ES CLIENTE de Golden: tiene un plan de cuotas. Le quedan ${moneda} ${Number(saldo.pending_amount ?? 0).toFixed(2)} por pagar` +
        `${Number(saldo.overdue_count ?? 0) > 0 ? `, con ${saldo.overdue_count} cuota(s) atrasada(s)` : ''}` +
        `${saldo.next_due_date ? `, y su próxima cuota vence el ${saldo.next_due_date}` : ''}.`,
      '- No le ofrezcas comprar: ayúdalo con su cuota, su voucher o su documento, y si pide detalles de su caso pásalo a cobranzas.',
    )
  } else {
    partes.push(
      '- TODAVÍA NO ES CLIENTE: es alguien interesado. Averigua qué busca (lote, casa o departamento, zona y presupuesto) y llévalo a agendar una cita con un asesor, por videollamada o presencial.',
      '- Si te pide una hora concreta, no la confirmes tú: pídele su nombre y en qué horario le queda bien, dile que un asesor se lo confirma, y pasa la conversación.',
    )
  }
  if (contacto.dni) {
    partes.push('- Puede entrar a la Golden App con su celular y su DNI, sin contraseña.');
  }
  return partes.join('\n')
}

/**
 * "Te paso con un asesor": se lo decimos al cliente y le suena el celular
 * a quien lleva la conversación. Todo mejor que el silencio.
 */
async function avisarQueSigueUnHumano(
  db: ReturnType<typeof supabaseAdmin>,
  args: { accountId: string; conversationId: string; contactId: string; configOwnerUserId: string },
): Promise<void> {
  const { data: conv } = await db
    .from('conversations')
    .select('assigned_agent_id, contact:contacts(name, phone)')
    .eq('id', args.conversationId)
    .maybeSingle()

  try {
    await engineSendText({
      accountId: args.accountId,
      userId: args.configOwnerUserId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      text: 'Con esto mejor te ayuda un asesor de Golden Habitat. Le aviso ahora mismo y te escribe en un momento. 🙌',
    })
  } catch (err) {
    console.error('[ai auto-reply] no se pudo avisar al cliente del traspaso:', err)
  }

  const quien = conv?.contact as unknown as { name?: string | null; phone?: string | null } | null
  await notifyConversation(db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    assignedAgentId: (conv?.assigned_agent_id as string | null) ?? null,
    title: 'Te toca a ti',
    body: `${quien?.name || quien?.phone || 'Un cliente'} necesita a una persona: la IA ya no puede seguir.`,
  }).catch((err) => console.error('[ai auto-reply] push del traspaso falló:', err))
}

/**
 * Whether the AI may still answer a conversation that has an advisor
 * assigned. Only for accounts with `ai_replies_until_agent_responds`
 * (migration 041), and only until a human sends the first message in the
 * thread. Any lookup failure — e.g. 041 not applied yet — keeps the old
 * behaviour: the assigned advisor owns the thread.
 */
async function aiCoversAssignedThread(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  conversationId: string,
): Promise<boolean> {
  const { data: account, error: accountErr } = await db
    .from('accounts')
    .select('ai_replies_until_agent_responds')
    .eq('id', accountId)
    .maybeSingle()
  if (accountErr || !account?.ai_replies_until_agent_responds) return false

  // Desde cuándo cuentan los mensajes del equipo: si al hilo se lo
  // devolvieron a la IA (botón "que siga la IA", 056), lo que el asesor
  // escribió antes ya no la silencia.
  const { data: conv } = await db
    .from('conversations')
    .select('ai_resumed_at')
    .eq('id', conversationId)
    .maybeSingle()
  const desde = (conv as { ai_resumed_at?: string | null } | null)?.ai_resumed_at ?? null

  let consulta = db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'agent')
    .limit(1)
  if (desde) consulta = consulta.gt('created_at', desde)

  const { data: agentMessages, error: msgErr } = await consulta
  if (msgErr || !agentMessages) return false
  return agentMessages.length === 0
}
