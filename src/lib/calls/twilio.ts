// ============================================================
// Twilio Programmable Voice — REST client.
//
// Raw `fetch`, no SDK: every Meta integration in this repo talks to
// its provider the same way, and Twilio's API is plain form-encoded
// POST with HTTP Basic auth. Adding the SDK would be a large
// dependency for three endpoints.
//
// Billing note worth preserving: Twilio charges per connected minute.
// Ringing that nobody answers costs nothing, so a dialer that burns
// through 400 unanswered attempts only pays for the 100 that connect.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { decrypt } from '@/lib/whatsapp/encryption'

const TWILIO_API = 'https://api.twilio.com/2010-04-01'

export interface TwilioCredentials {
  accountSid: string
  authToken: string
  fromNumber: string
}

export interface TwilioConfigRow {
  account_id: string
  account_sid: string | null
  auth_token: string | null
  from_number: string | null
  is_active: boolean
  verified_at: string | null
}

/** HTTP Basic header for the Twilio REST API. */
function basicAuth(accountSid: string, authToken: string): string {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`
}

/**
 * Load and decrypt an account's Twilio credentials. Returns null when
 * unconfigured, inactive, or incomplete — callers treat that as "this
 * account can't dial" rather than an error.
 */
export async function loadTwilioCredentials(
  db: SupabaseClient,
  accountId: string,
): Promise<TwilioCredentials | null> {
  const { data, error } = await db
    .from('twilio_configs')
    .select('account_id, account_sid, auth_token, from_number, is_active, verified_at')
    .eq('account_id', accountId)
    .maybeSingle()

  if (error || !data) return null
  const row = data as TwilioConfigRow
  if (!row.is_active) return null
  if (!row.account_sid || !row.auth_token || !row.from_number) return null

  try {
    return {
      accountSid: row.account_sid,
      authToken: decrypt(row.auth_token),
      fromNumber: row.from_number,
    }
  } catch (err) {
    console.error('[twilio] auth_token decryption failed:', err)
    return null
  }
}

export class TwilioError extends Error {
  readonly status: number
  readonly code: number | null
  constructor(message: string, status: number, code: number | null = null) {
    super(message)
    this.name = 'TwilioError'
    this.status = status
    this.code = code
  }
}

async function twilioRequest(
  creds: Pick<TwilioCredentials, 'accountSid' | 'authToken'>,
  path: string,
  init: { method: 'GET' | 'POST'; body?: URLSearchParams },
): Promise<unknown> {
  const res = await fetch(`${TWILIO_API}/Accounts/${creds.accountSid}${path}`, {
    method: init.method,
    headers: {
      Authorization: basicAuth(creds.accountSid, creds.authToken),
      ...(init.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: init.body,
  })

  const json = (await res.json().catch(() => null)) as
    | { message?: string; code?: number }
    | null

  if (!res.ok) {
    throw new TwilioError(
      json?.message ?? `Twilio API error: ${res.status}`,
      res.status,
      json?.code ?? null,
    )
  }
  return json
}

/**
 * Confirm the credentials work and the from-number is usable. Called
 * by the "Probar conexión" button before we ever place a real call.
 *
 * Checks the number is present on the account's Incoming Phone Numbers
 * OR its Outgoing Caller IDs — Twilio allows dialing from either, and
 * a verified caller ID (the cheaper path: no number purchase, just a
 * PIN callback) only appears in the latter.
 */
export async function validateTwilioCredentials(
  creds: TwilioCredentials,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await twilioRequest(creds, '.json', { method: 'GET' })
  } catch (err) {
    if (err instanceof TwilioError) {
      return {
        ok: false,
        error:
          err.status === 401
            ? 'Account SID o Auth Token incorrectos.'
            : err.message,
      }
    }
    return { ok: false, error: 'No se pudo contactar a Twilio.' }
  }

  const query = new URLSearchParams({ PhoneNumber: creds.fromNumber })
  try {
    const [incoming, outgoing] = await Promise.all([
      twilioRequest(creds, `/IncomingPhoneNumbers.json?${query}`, { method: 'GET' }),
      twilioRequest(creds, `/OutgoingCallerIds.json?${query}`, { method: 'GET' }),
    ])
    const owned =
      ((incoming as { incoming_phone_numbers?: unknown[] })?.incoming_phone_numbers ?? [])
        .length > 0
    const verified =
      ((outgoing as { outgoing_caller_ids?: unknown[] })?.outgoing_caller_ids ?? [])
        .length > 0

    if (!owned && !verified) {
      return {
        ok: false,
        error:
          `El número ${creds.fromNumber} no está en tu cuenta de Twilio ni verificado como caller ID. ` +
          'Verifícalo en Twilio (te llaman con un PIN) antes de marcar.',
      }
    }
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof TwilioError ? err.message : 'No se pudo verificar el número.',
    }
  }
}

export interface CreateCallArgs {
  to: string
  /** Public URL Twilio fetches for TwiML when the call is answered. */
  voiceUrl: string
  /** Public URL Twilio POSTs call lifecycle events to. */
  statusCallbackUrl: string
  /** Seconds to ring before giving up. Twilio allows 5–600. */
  timeoutSec?: number
}

export interface CreateCallResult {
  sid: string
  status: string
}

/**
 * Place one outbound call.
 *
 * `statusCallbackEvent=completed` only — the dialer advances on the
 * terminal event, and subscribing to ringing/answered too would triple
 * the webhook volume for no gain (the answered case is already handled
 * by Twilio fetching the TwiML URL).
 */
export async function createCall(
  creds: TwilioCredentials,
  args: CreateCallArgs,
): Promise<CreateCallResult> {
  const body = new URLSearchParams({
    To: args.to,
    From: creds.fromNumber,
    Url: args.voiceUrl,
    StatusCallback: args.statusCallbackUrl,
    StatusCallbackMethod: 'POST',
    Timeout: String(args.timeoutSec ?? 25),
  })
  body.append('StatusCallbackEvent', 'completed')

  const json = (await twilioRequest(creds, '/Calls.json', {
    method: 'POST',
    body,
  })) as { sid?: string; status?: string } | null

  if (!json?.sid) {
    throw new TwilioError('Twilio did not return a call SID', 502)
  }
  return { sid: json.sid, status: json.status ?? 'queued' }
}

/**
 * Download a recording's audio. Twilio serves the media from the
 * recording URL with `.mp3` appended, behind the same Basic auth.
 * Returns the bytes for handing to transcription.
 */
export async function fetchRecording(
  creds: Pick<TwilioCredentials, 'accountSid' | 'authToken'>,
  recordingUrl: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const url = recordingUrl.endsWith('.mp3') ? recordingUrl : `${recordingUrl}.mp3`
  const res = await fetch(url, {
    headers: { Authorization: basicAuth(creds.accountSid, creds.authToken) },
  })
  if (!res.ok) {
    throw new TwilioError(`No se pudo descargar la grabación: ${res.status}`, res.status)
  }
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') ?? 'audio/mpeg',
  }
}
