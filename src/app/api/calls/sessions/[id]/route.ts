// ============================================================
// PATCH /api/calls/sessions/[id]
//
// Pause, resume, or finish a dialing session.
//
// Pausing does NOT cut a call in progress — it stops the queue from
// advancing once the current call ends. Hanging up on a lead mid-
// sentence because someone clicked pause would be worse than letting
// the conversation finish.
// ============================================================

import { NextResponse, after } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getBaseUrl } from '@/lib/auth/invitations'
import { supabaseAdmin } from '@/lib/calls/admin-client'
import { dialNext, finalizeSession } from '@/lib/calls/engine'

type Action = 'pausar' | 'reanudar' | 'finalizar'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params

    const body = (await request.json().catch(() => null)) as { action?: unknown } | null
    const action = body?.action as Action | undefined
    if (!action || !['pausar', 'reanudar', 'finalizar'].includes(action)) {
      return NextResponse.json(
        { error: 'action debe ser pausar, reanudar o finalizar' },
        { status: 400 },
      )
    }

    const { data: session } = await supabase
      .from('dial_sessions')
      .select('id, status, active_attempt_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!session) {
      return NextResponse.json({ error: 'Sesión no encontrada' }, { status: 404 })
    }

    const db = supabaseAdmin()

    if (action === 'finalizar') {
      await finalizeSession(db, id)
      return NextResponse.json({ success: true, status: 'finalizada' })
    }

    if (action === 'pausar') {
      const { error } = await db
        .from('dial_sessions')
        .update({ status: 'pausada' })
        .eq('id', id)
      if (error) {
        return NextResponse.json({ error: 'No se pudo pausar' }, { status: 500 })
      }
      return NextResponse.json({ success: true, status: 'pausada' })
    }

    // Resume: flip back to active, then kick the queue — nothing else
    // will, since the callback that would have advanced it already
    // fired while we were paused.
    const { error } = await db
      .from('dial_sessions')
      .update({ status: 'activa' })
      .eq('id', id)
    if (error) {
      return NextResponse.json({ error: 'No se pudo reanudar' }, { status: 500 })
    }

    const baseUrl = getBaseUrl(request)
    after(
      dialNext(db, id, baseUrl).catch((err) =>
        console.error('[dialer resume] dialNext failed:', err),
      ),
    )
    return NextResponse.json({ success: true, status: 'activa' })
  } catch (err) {
    return toErrorResponse(err)
  }
}
