import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/calls/admin-client'
import { runBroadcastDispatch } from '@/lib/whatsapp/broadcast-dispatch'

/**
 * Send the scheduled (and "send now") WhatsApp broadcasts that are due.
 *
 * The wizard only saves a broadcast and its recipients; this endpoint
 * does the sending so it goes out with the browser closed. Trigger it
 * with a GET every minute from an external pinger (see
 * docs/broadcasts-scheduling.md). A run works for at most ~240 s and
 * leaves the rest for the next tick, so overlapping/late ticks are safe:
 * each broadcast is claimed with a compare-and-swap UPDATE.
 *
 * Auth is the same as /api/calls/cron:
 *   - `x-cron-secret: <AUTOMATION_CRON_SECRET>` for an external pinger.
 *   - `Authorization: Bearer <CRON_SECRET>` (what Vercel Cron sends).
 */
export const maxDuration = 300

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

  try {
    const summary = await runBroadcastDispatch(supabaseAdmin())
    return NextResponse.json(summary)
  } catch (err) {
    console.error('[broadcasts cron] dispatch failed:', err)
    return NextResponse.json({ error: 'dispatch failed' }, { status: 500 })
  }
}
