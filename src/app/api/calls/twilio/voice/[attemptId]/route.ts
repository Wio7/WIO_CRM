// ============================================================
// POST /api/calls/twilio/voice/[attemptId]
//
// Twilio fetches this the instant the lead answers, and plays back
// whatever TwiML we return. This is the only moment that differs
// between manual mode and AI mode: bridge to a human, or hand the
// call to a voice agent. Everything before it — queue, sequential
// dialing, retries — is the same engine.
//
// The `<Say>` recording notice comes first, deliberately: the lead
// hears it before the bridge connects. Recording someone without
// notice is not defensible in Peru, and it costs one line.
// ============================================================

import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/calls/admin-client'
import { loadTwilioCredentials } from '@/lib/calls/twilio'
import { verifyTwilioSignature, parseTwilioForm } from '@/lib/calls/twilio-signature'
import { getBaseUrl } from '@/lib/auth/invitations'

const RECORDING_NOTICE =
  'Esta llamada será grabada con fines de calidad y seguimiento.'

/** TwiML that just hangs up — used whenever we can't safely bridge. */
function hangup(message?: string): NextResponse {
  const say = message
    ? `<Say language="es-MX">${escapeXml(message)}</Say>`
    : ''
  return new NextResponse(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Hangup/></Response>`,
    { status: 200, headers: { 'Content-Type': 'text/xml' } },
  )
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ attemptId: string }> },
) {
  const { attemptId } = await params
  const form = await parseTwilioForm(request)
  const db = supabaseAdmin()

  const { data: attempt } = await db
    .from('call_attempts')
    .select('id, account_id, queue_item_id')
    .eq('id', attemptId)
    .maybeSingle()
  if (!attempt) return hangup()

  const creds = await loadTwilioCredentials(db, attempt.account_id as string)
  if (!verifyTwilioSignature(request.url, form, request.headers.get('x-twilio-signature'), creds?.authToken ?? null)) {
    return new NextResponse('Invalid signature', { status: 403 })
  }

  // Who to bridge to: the advisor running this session.
  const { data: item } = await db
    .from('dial_queue_items')
    .select('session_id')
    .eq('id', attempt.queue_item_id as string)
    .maybeSingle()
  const { data: session } = item
    ? await db
        .from('dial_sessions')
        .select('advisor_id, mode')
        .eq('id', item.session_id as string)
        .maybeSingle()
    : { data: null }

  if (!session?.advisor_id) return hangup(RECORDING_NOTICE)

  const { data: advisor } = await db
    .from('profiles')
    .select('phone')
    .eq('id', session.advisor_id as string)
    .maybeSingle()

  const advisorPhone = advisor?.phone as string | null
  if (!advisorPhone) {
    console.error('[dialer voice] advisor has no phone — cannot bridge', attemptId)
    return hangup(RECORDING_NOTICE)
  }

  const base = getBaseUrl(request)
  const recordingCallback = `${base}/api/calls/twilio/recording/${attemptId}`

  // `record-from-answer-dual` captures both legs on separate channels,
  // which transcribes far better than a mixed mono recording.
  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say language="es-MX">${escapeXml(RECORDING_NOTICE)}</Say>` +
    `<Dial timeout="30" callerId="${escapeXml(creds?.fromNumber ?? '')}" ` +
    `record="record-from-answer-dual" ` +
    `recordingStatusCallback="${escapeXml(recordingCallback)}" ` +
    `recordingStatusCallbackMethod="POST">` +
    `<Number>${escapeXml(advisorPhone)}</Number>` +
    `</Dial>` +
    `</Response>`

  return new NextResponse(twiml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  })
}
