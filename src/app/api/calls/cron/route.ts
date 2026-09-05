import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/calls/admin-client'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { loadTwilioCredentials, fetchRecording } from '@/lib/calls/twilio'
import { transcribeAudio } from '@/lib/calls/transcribe'
import { summarizeCall } from '@/lib/calls/summarize'

/**
 * Drain the transcription backlog for answered calls.
 *
 * The recording webhook deliberately does none of this work: pulling a
 * five-minute MP3, running Whisper over it, then asking an LLM for a
 * summary can outlast a serverless function's budget, and a webhook
 * that times out is one Twilio retries. So the webhook only stores the
 * recording URL and leaves `transcription_status = 'pendiente'`; this
 * endpoint does the slow part on a schedule, where a timeout costs
 * nothing but a retry on the next tick.
 *
 * Auth accepts two shapes, because two very different callers need in:
 *
 *   - `x-cron-secret: <AUTOMATION_CRON_SECRET>` — the convention the
 *     other two cron routes use, for an external pinger or GitHub
 *     Actions.
 *   - `Authorization: Bearer <CRON_SECRET>` — what Vercel Cron itself
 *     sends. Vercel does NOT let you set custom headers on a cron, so
 *     header-only auth would 401 every scheduled run.
 *
 * Each row is claimed with a compare-and-swap UPDATE before any work
 * starts, so two overlapping ticks can't transcribe the same call
 * twice (and pay OpenAI twice for it).
 */
export const maxDuration = 300

const BATCH = 5

/** Constant-time compare; length pre-check because timingSafeEqual throws. */
function secretMatches(supplied: string, expected: string | undefined): boolean {
  if (!expected) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  const headerSecret = process.env.AUTOMATION_CRON_SECRET
  const vercelSecret = process.env.CRON_SECRET
  if (!headerSecret && !vercelSecret) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }

  const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const authorized =
    secretMatches(request.headers.get('x-cron-secret') ?? '', headerSecret) ||
    secretMatches(bearer, vercelSecret)

  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = supabaseAdmin()

  // Only rows that actually have audio to work with.
  const { data: pending, error } = await db
    .from('call_results')
    .select('id, account_id, recording_url')
    .eq('transcription_status', 'pendiente')
    .not('recording_url', 'is', null)
    .order('created_at', { ascending: true })
    .limit(BATCH)

  if (error) {
    console.error('[calls cron] fetch failed:', error)
    return NextResponse.json({ error: 'query failed' }, { status: 500 })
  }

  let processed = 0
  let skipped = 0
  let failed = 0

  for (const row of pending ?? []) {
    // Claim: only one tick wins the transition out of 'pendiente'.
    const { data: claimed } = await db
      .from('call_results')
      .update({ transcription_status: 'procesando' })
      .eq('id', row.id)
      .eq('transcription_status', 'pendiente')
      .select('id')
      .maybeSingle()
    if (!claimed) continue

    const accountId = row.account_id as string

    try {
      const { key: openaiKey } = await loadEmbeddingsKey(db, accountId)
      if (!openaiKey) {
        // No OpenAI key on this account — the recording and duration
        // are still useful on their own, so this is 'omitido', not a
        // failure to retry forever.
        await db
          .from('call_results')
          .update({
            transcription_status: 'omitido',
            transcription_error:
              'Falta la clave de OpenAI (Configuración → Agentes IA) para transcribir.',
          })
          .eq('id', row.id)
        skipped++
        continue
      }

      const creds = await loadTwilioCredentials(db, accountId)
      if (!creds) {
        await db
          .from('call_results')
          .update({
            transcription_status: 'fallo',
            transcription_error: 'Twilio no está configurado para esta cuenta.',
          })
          .eq('id', row.id)
        failed++
        continue
      }

      const audio = await fetchRecording(creds, row.recording_url as string)
      const transcript = await transcribeAudio({
        apiKey: openaiKey,
        bytes: audio.bytes,
        contentType: audio.contentType,
      })

      // A missing AI config costs the summary, not the transcript.
      let summary: string | null = null
      let recommendation: string | null = null
      try {
        const result = await summarizeCall(db, accountId, transcript)
        if (result) {
          summary = result.summary
          recommendation = result.recommendation
        }
      } catch (err) {
        console.error('[calls cron] summarization failed:', err)
      }

      await db
        .from('call_results')
        .update({
          transcript,
          ai_summary: summary,
          ai_recommendation: recommendation,
          transcription_status: 'listo',
          transcription_error: null,
        })
        .eq('id', row.id)
      processed++
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error desconocido'
      console.error('[calls cron] transcription failed:', row.id, err)
      await db
        .from('call_results')
        .update({ transcription_status: 'fallo', transcription_error: message })
        .eq('id', row.id)
      failed++
    }
  }

  return NextResponse.json({ processed, skipped, failed })
}
