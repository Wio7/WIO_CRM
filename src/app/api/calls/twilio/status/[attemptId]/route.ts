// ============================================================
// POST /api/calls/twilio/status/[attemptId]
//
// The engine's clock. Twilio posts here when a call reaches a terminal
// state; recording the outcome and dialing the next lead both hang off
// this. Responds 200 immediately and does the work in `after()` so a
// slow Graph/DB round-trip can't make Twilio time out and retry
// (which would look like a duplicate event).
// ============================================================

import { NextResponse, after } from 'next/server'

import { supabaseAdmin } from '@/lib/calls/admin-client'
import { loadTwilioCredentials } from '@/lib/calls/twilio'
import { verifyTwilioSignature, parseTwilioForm } from '@/lib/calls/twilio-signature'
import { handleCallStatus } from '@/lib/calls/engine'
import { getBaseUrl } from '@/lib/auth/invitations'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ attemptId: string }> },
) {
  const { attemptId } = await params
  const form = await parseTwilioForm(request)
  const db = supabaseAdmin()

  const { data: attempt } = await db
    .from('call_attempts')
    .select('id, account_id')
    .eq('id', attemptId)
    .maybeSingle()
  if (!attempt) {
    // Ack anyway: retrying an unknown attempt helps nobody.
    return NextResponse.json({ received: true })
  }

  const creds = await loadTwilioCredentials(db, attempt.account_id as string)
  if (
    !verifyTwilioSignature(
      request.url,
      form,
      request.headers.get('x-twilio-signature'),
      creds?.authToken ?? null,
    )
  ) {
    return new NextResponse('Invalid signature', { status: 403 })
  }

  const callStatus = form.CallStatus ?? ''
  const rawDuration = form.CallDuration
  const durationSec = rawDuration ? Number.parseInt(rawDuration, 10) : null

  const baseUrl = getBaseUrl(request)
  after(
    handleCallStatus(db, {
      attemptId,
      callStatus,
      durationSec: Number.isFinite(durationSec) ? durationSec : null,
      baseUrl,
    }).catch((err) => console.error('[dialer status] handling failed:', err)),
  )

  return NextResponse.json({ received: true })
}
