// ============================================================
// POST /api/calls/twilio/recording/[attemptId]
//
// Twilio posts here once the recording is ready. This route does the
// minimum: store the URL and leave `transcription_status = 'pendiente'`.
//
// It deliberately does NOT transcribe inline. Downloading a five-minute
// recording, running Whisper over it, then asking an LLM for a summary
// can easily outlast a serverless function's budget — and a webhook
// that times out is a webhook Twilio retries. The cron at
// /api/calls/cron drains the pending queue instead.
// ============================================================

import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/calls/admin-client'
import { loadTwilioCredentials } from '@/lib/calls/twilio'
import { verifyTwilioSignature, parseTwilioForm } from '@/lib/calls/twilio-signature'

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
  if (!attempt) return NextResponse.json({ received: true })

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

  const recordingUrl = form.RecordingUrl
  const recordingStatus = form.RecordingStatus
  if (!recordingUrl || recordingStatus !== 'completed') {
    return NextResponse.json({ received: true })
  }

  const durationRaw = form.RecordingDuration
  const duration = durationRaw ? Number.parseInt(durationRaw, 10) : null

  const { error } = await db
    .from('call_results')
    .update({
      recording_url: recordingUrl,
      ...(Number.isFinite(duration) ? { duration_sec: duration } : {}),
    })
    .eq('attempt_id', attemptId)
    .eq('account_id', attempt.account_id as string)

  if (error) {
    console.error('[dialer recording] update failed:', error)
  }

  return NextResponse.json({ received: true })
}
