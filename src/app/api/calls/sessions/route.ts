// ============================================================
// GET/POST /api/calls/sessions
//
// GET  — the caller's current dialing session with live queue counts,
//        for the dialer screen to poll.
// POST — "Iniciar marcado": enqueue contacts and place the first call.
//
// Writes go through the service-role client because the engine also
// runs from Twilio webhooks (no session there) and must behave
// identically either way. Authorization is enforced here, before the
// engine is reached: requireRole('agent') plus an explicit account
// scope on every engine query.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getBaseUrl } from '@/lib/auth/invitations'
import { supabaseAdmin } from '@/lib/calls/admin-client'
import { startSession, DialerError } from '@/lib/calls/engine'

const MAX_QUEUE = 500

export async function GET() {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()

    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle()
    if (!profile) return NextResponse.json({ session: null })

    const { data: session } = await supabase
      .from('dial_sessions')
      .select('id, mode, status, active_attempt_id, started_at')
      .eq('account_id', accountId)
      .eq('advisor_id', profile.id)
      .in('status', ['activa', 'pausada'])
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!session) return NextResponse.json({ session: null })

    const { data: items } = await supabase
      .from('dial_queue_items')
      .select('status, contact:contacts(id, name, phone)')
      .eq('session_id', session.id)

    const rows = items ?? []
    const counts = rows.reduce<Record<string, number>>((acc, r) => {
      const key = r.status as string
      acc[key] = (acc[key] ?? 0) + 1
      return acc
    }, {})

    // Who is being dialed right now, if anyone.
    let current: { name: string | null; phone: string | null } | null = null
    if (session.active_attempt_id) {
      const { data: attempt } = await supabase
        .from('call_attempts')
        .select('phone_dialed, queue_item:dial_queue_items(contact:contacts(name))')
        .eq('id', session.active_attempt_id)
        .maybeSingle()
      if (attempt) {
        const qi = attempt.queue_item as { contact?: { name?: string } } | null
        current = {
          name: qi?.contact?.name ?? null,
          phone: attempt.phone_dialed as string,
        }
      }
    }

    return NextResponse.json({
      session: {
        id: session.id,
        mode: session.mode,
        status: session.status,
        started_at: session.started_at,
        current,
        counts: {
          pendiente: counts.pendiente ?? 0,
          en_progreso: counts.en_progreso ?? 0,
          completado: counts.completado ?? 0,
          omitido: counts.omitido ?? 0,
          total: rows.length,
        },
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`dial-start:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as {
      contact_ids?: unknown
    } | null

    if (!Array.isArray(body?.contact_ids) || body.contact_ids.length === 0) {
      return NextResponse.json(
        { error: 'Selecciona al menos un contacto para marcar.' },
        { status: 400 },
      )
    }
    const contactIds = body.contact_ids.filter(
      (id): id is string => typeof id === 'string',
    )
    if (contactIds.length > MAX_QUEUE) {
      return NextResponse.json(
        { error: `Máximo ${MAX_QUEUE} contactos por sesión.` },
        { status: 400 },
      )
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle()
    if (!profile) {
      return NextResponse.json({ error: 'Perfil no encontrado' }, { status: 403 })
    }

    // Refuse to start a second session for the same advisor: one person
    // can only be on one call at a time, and two live queues would
    // fight over the same phone.
    const { data: existing } = await supabase
      .from('dial_sessions')
      .select('id')
      .eq('account_id', accountId)
      .eq('advisor_id', profile.id)
      .eq('status', 'activa')
      .maybeSingle()
    if (existing) {
      return NextResponse.json(
        { error: 'Ya tienes una sesión de marcado activa.', session_id: existing.id },
        { status: 409 },
      )
    }

    const result = await startSession(supabaseAdmin(), {
      accountId,
      advisorId: profile.id as string,
      contactIds,
      baseUrl: getBaseUrl(request),
    })

    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    if (err instanceof DialerError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
    }
    return toErrorResponse(err)
  }
}
