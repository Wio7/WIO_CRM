// ============================================================
// Power Dialer engine.
//
// The dialer is a state machine driven by Twilio's webhooks, not a
// loop: pressing "Iniciar marcado" places exactly ONE call, and every
// subsequent call is placed by the status callback of the previous
// one. That's what lets this run on serverless with no long-lived
// process, and it's also functionally correct — a power dialer dials
// one at a time per advisor by definition.
//
//   startSession → dialNext ──► Twilio rings the lead
//                                     │
//        ┌────────────────────────────┴──────────────┐
//        │ answered                                   │ not answered
//        ▼                                            ▼
//   TwiML bridges to the advisor              handleCallStatus:
//   (voice route), then on hangup             next number of the same
//   the status callback fires ───────────────► lead, else next lead
//
// Every query goes through the service-role client (Twilio webhooks
// carry no user session), so each one carries an explicit
// `.eq('account_id', ...)` — RLS is not doing the scoping here.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { createCall, loadTwilioCredentials, type TwilioCredentials } from './twilio'

export interface StartSessionArgs {
  accountId: string
  /** profiles.id of the advisor running the session. */
  advisorId: string
  contactIds: string[]
  /** Public origin, e.g. https://wio-crm.vercel.app */
  baseUrl: string
}

export interface StartSessionResult {
  sessionId: string
  queued: number
  skipped: { contactId: string; reason: string }[]
}

export class DialerError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'DialerError'
    this.code = code
  }
}

/**
 * Create a session, enqueue the contacts, and place the first call.
 *
 * Contacts on the do-not-call list or without a usable number are
 * enqueued as `omitido` rather than silently dropped — the advisor
 * should be able to see WHY someone wasn't called.
 */
export async function startSession(
  db: SupabaseClient,
  args: StartSessionArgs,
): Promise<StartSessionResult> {
  const creds = await loadTwilioCredentials(db, args.accountId)
  if (!creds) {
    throw new DialerError(
      'Twilio no está configurado o está inactivo para esta cuenta.',
      'twilio_not_configured',
    )
  }

  const { data: advisor } = await db
    .from('profiles')
    .select('phone')
    .eq('id', args.advisorId)
    .maybeSingle()
  if (!advisor?.phone) {
    throw new DialerError(
      'Configura tu teléfono en Configuración → Marcador antes de iniciar.',
      'advisor_phone_missing',
    )
  }

  const { data: contacts, error: contactsErr } = await db
    .from('contacts')
    .select('id, phone, phone_normalized')
    .eq('account_id', args.accountId)
    .in('id', args.contactIds)
  if (contactsErr) {
    throw new DialerError('No se pudieron cargar los contactos.', 'contacts_load_failed')
  }

  // One query for the whole exclusion check rather than per contact.
  const { data: dncRows } = await db
    .from('do_not_call')
    .select('phone_normalized')
    .eq('account_id', args.accountId)
  const blocked = new Set((dncRows ?? []).map((r) => r.phone_normalized as string))

  const { data: session, error: sessionErr } = await db
    .from('dial_sessions')
    .insert({
      account_id: args.accountId,
      advisor_id: args.advisorId,
      mode: 'manual',
      status: 'activa',
    })
    .select('id')
    .single()
  if (sessionErr || !session) {
    throw new DialerError('No se pudo crear la sesión.', 'session_create_failed')
  }

  const skipped: StartSessionResult['skipped'] = []
  const rows = (contacts ?? []).map((c) => {
    const phone = (c.phone as string | null) ?? ''
    const normalized = (c.phone_normalized as string | null) ?? normalizePhone(phone)

    let status = 'pendiente'
    let skipReason: string | null = null
    if (!phone) {
      status = 'omitido'
      skipReason = 'sin_numero'
    } else if (normalized && blocked.has(normalized)) {
      status = 'omitido'
      skipReason = 'lista_no_llamar'
    }
    if (skipReason) skipped.push({ contactId: c.id as string, reason: skipReason })

    return {
      session_id: session.id,
      account_id: args.accountId,
      contact_id: c.id,
      // Snapshot, ordered. Frozen here on purpose: editing the contact
      // mid-session must not change what the advisor is dialing.
      phones: phone ? [phone] : [],
      phone_index: 0,
      status,
      skip_reason: skipReason,
    }
  })

  if (rows.length > 0) {
    const { error } = await db.from('dial_queue_items').insert(rows)
    if (error) {
      throw new DialerError('No se pudo encolar los contactos.', 'queue_insert_failed')
    }
  }

  const queued = rows.filter((r) => r.status === 'pendiente').length
  if (queued > 0) {
    await dialNext(db, session.id, args.baseUrl, creds)
  } else {
    await finalizeSession(db, session.id)
  }

  return { sessionId: session.id, queued, skipped }
}

/**
 * Claim the next queued lead and place a call to it.
 *
 * The claim is a single atomic RPC (`claim_next_dial_item`) so two
 * concurrent status callbacks — Twilio retries — can't both pull the
 * same lead and double-dial someone.
 */
export async function dialNext(
  db: SupabaseClient,
  sessionId: string,
  baseUrl: string,
  creds?: TwilioCredentials,
): Promise<void> {
  const { data: session } = await db
    .from('dial_sessions')
    .select('id, account_id, status')
    .eq('id', sessionId)
    .maybeSingle()
  if (!session || session.status !== 'activa') return

  const credentials =
    creds ?? (await loadTwilioCredentials(db, session.account_id as string))
  if (!credentials) {
    console.error('[dialer] no Twilio credentials — pausing session', sessionId)
    await db
      .from('dial_sessions')
      .update({ status: 'pausada' })
      .eq('id', sessionId)
    return
  }

  const { data: claimed, error } = await db.rpc('claim_next_dial_item', {
    p_session_id: sessionId,
  })
  if (error) {
    console.error('[dialer] claim failed:', error)
    return
  }

  const item = Array.isArray(claimed) ? claimed[0] : claimed
  if (!item) {
    // Nothing claimable: either the queue is drained or another
    // callback already has a call in flight. Only finalize on the
    // former, so we don't kill a live session.
    const { count } = await db
      .from('dial_queue_items')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .eq('status', 'pendiente')
    if ((count ?? 0) === 0) await finalizeSession(db, sessionId)
    return
  }

  await placeCall(db, {
    sessionId,
    accountId: session.account_id as string,
    itemId: item.item_id as string,
    phones: (item.phones as string[]) ?? [],
    phoneIndex: (item.phone_index as number) ?? 0,
    baseUrl,
    creds: credentials,
  })
}

interface PlaceCallArgs {
  sessionId: string
  accountId: string
  itemId: string
  phones: string[]
  phoneIndex: number
  baseUrl: string
  creds: TwilioCredentials
}

/**
 * Place one call for an already-claimed queue item. The attempt row is
 * created BEFORE contacting Twilio because its id is what the webhook
 * URLs are keyed on — that's how a callback resolves back to the
 * account, session and queue item.
 */
async function placeCall(db: SupabaseClient, args: PlaceCallArgs): Promise<void> {
  const phone = args.phones[args.phoneIndex]
  if (!phone) {
    await completeItem(db, args.itemId)
    await dialNext(db, args.sessionId, args.baseUrl, args.creds)
    return
  }

  const { data: attempt, error: attemptErr } = await db
    .from('call_attempts')
    .insert({
      queue_item_id: args.itemId,
      account_id: args.accountId,
      phone_dialed: phone,
    })
    .select('id')
    .single()
  if (attemptErr || !attempt) {
    console.error('[dialer] attempt insert failed:', attemptErr)
    await completeItem(db, args.itemId)
    return
  }

  // Mark the session busy before dialing: if Twilio answers fast, the
  // status callback could otherwise race us and try to dial again.
  await db
    .from('dial_sessions')
    .update({ active_attempt_id: attempt.id })
    .eq('id', args.sessionId)

  try {
    const call = await createCall(args.creds, {
      to: phone,
      voiceUrl: `${args.baseUrl}/api/calls/twilio/voice/${attempt.id}`,
      statusCallbackUrl: `${args.baseUrl}/api/calls/twilio/status/${attempt.id}`,
    })
    await db
      .from('call_attempts')
      .update({ twilio_call_sid: call.sid })
      .eq('id', attempt.id)
  } catch (err) {
    console.error('[dialer] createCall failed:', err)
    await db
      .from('call_attempts')
      .update({ result: 'fallo', ended_at: new Date().toISOString() })
      .eq('id', attempt.id)
    await db
      .from('dial_sessions')
      .update({ active_attempt_id: null })
      .eq('id', args.sessionId)
    // A failed placement shouldn't strand the session — move on.
    await advanceAfterAttempt(db, {
      attemptId: attempt.id,
      itemId: args.itemId,
      sessionId: args.sessionId,
      answered: false,
      baseUrl: args.baseUrl,
    })
  }
}

/** Twilio's terminal CallStatus values → our `call_attempts.result`. */
export function mapTwilioStatus(status: string): string {
  switch (status) {
    case 'completed':
      return 'contesto'
    case 'no-answer':
      return 'no_contesto'
    case 'busy':
      return 'ocupado'
    case 'canceled':
      return 'cancelado'
    default:
      return 'fallo'
  }
}

export interface CallStatusArgs {
  attemptId: string
  callStatus: string
  durationSec: number | null
  baseUrl: string
}

/**
 * Record the outcome of an attempt and move the queue forward.
 * Called from the Twilio status webhook after the response is sent.
 */
export async function handleCallStatus(
  db: SupabaseClient,
  args: CallStatusArgs,
): Promise<void> {
  const { data: attempt } = await db
    .from('call_attempts')
    .select('id, queue_item_id, account_id, result')
    .eq('id', args.attemptId)
    .maybeSingle()
  if (!attempt) return
  // Twilio can deliver the same terminal event more than once.
  if (attempt.result) return

  const result = mapTwilioStatus(args.callStatus)
  const answered = result === 'contesto'

  await db
    .from('call_attempts')
    .update({
      result,
      duration_sec: args.durationSec,
      ended_at: new Date().toISOString(),
    })
    .eq('id', attempt.id)

  const { data: item } = await db
    .from('dial_queue_items')
    .select('id, session_id, contact_id, phones, phone_index')
    .eq('id', attempt.queue_item_id as string)
    .maybeSingle()
  if (!item) return

  if (answered) {
    const { data: session } = await db
      .from('dial_sessions')
      .select('advisor_id, mode')
      .eq('id', item.session_id as string)
      .maybeSingle()

    // One result row per answered attempt. The recording webhook fills
    // in the URL later; transcription is left 'pendiente' for the cron.
    await db.from('call_results').insert({
      attempt_id: attempt.id,
      account_id: attempt.account_id,
      contact_id: item.contact_id,
      advisor_id: session?.advisor_id ?? null,
      mode: session?.mode ?? 'manual',
      duration_sec: args.durationSec,
      transcription_status: 'pendiente',
    })
  }

  await advanceAfterAttempt(db, {
    attemptId: attempt.id,
    itemId: item.id as string,
    sessionId: item.session_id as string,
    answered,
    baseUrl: args.baseUrl,
    phones: (item.phones as string[]) ?? [],
    phoneIndex: (item.phone_index as number) ?? 0,
  })
}

interface AdvanceArgs {
  attemptId: string
  itemId: string
  sessionId: string
  answered: boolean
  baseUrl: string
  phones?: string[]
  phoneIndex?: number
}

/**
 * Decide what happens after an attempt ends.
 *
 * Unanswered and the lead has another number → dial that number for the
 * SAME lead (the spec's "marca secuencialmente los números de un lead").
 * Otherwise the lead is done and we claim the next one.
 */
async function advanceAfterAttempt(db: SupabaseClient, args: AdvanceArgs): Promise<void> {
  // Free the session before anything else, or dialNext's claim will
  // see a call still in flight and refuse.
  await db
    .from('dial_sessions')
    .update({ active_attempt_id: null })
    .eq('id', args.sessionId)
    .eq('active_attempt_id', args.attemptId)

  const phones = args.phones ?? []
  const nextIndex = (args.phoneIndex ?? 0) + 1

  if (!args.answered && nextIndex < phones.length) {
    await db
      .from('dial_queue_items')
      .update({ phone_index: nextIndex, status: 'pendiente' })
      .eq('id', args.itemId)
  } else {
    await completeItem(db, args.itemId)
  }

  await dialNext(db, args.sessionId, args.baseUrl)
}

async function completeItem(db: SupabaseClient, itemId: string): Promise<void> {
  await db
    .from('dial_queue_items')
    .update({ status: 'completado' })
    .eq('id', itemId)
}

export async function finalizeSession(
  db: SupabaseClient,
  sessionId: string,
): Promise<void> {
  await db
    .from('dial_sessions')
    .update({
      status: 'finalizada',
      ended_at: new Date().toISOString(),
      active_attempt_id: null,
    })
    .eq('id', sessionId)
}
