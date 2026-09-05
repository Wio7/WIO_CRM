// ============================================================
// GET/POST/DELETE /api/calls/config
//
// Per-account Twilio credentials for the Power Dialer (migration 038).
// Uses the caller's RLS session client, so the admin-only policies on
// `twilio_configs` enforce authorization at the database, not in app
// code — same posture as /api/meta-leads/config.
//
// The Auth Token is AES-256-GCM encrypted before storage and NEVER
// returned by GET (only a boolean saying whether one is set).
//
// POST also validates the credentials against Twilio's API before
// marking the config verified, so a typo surfaces immediately instead
// of at the first real call.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { validateTwilioCredentials } from '@/lib/calls/twilio'

export async function GET() {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()

    const [{ data: config }, { data: profile }, { count: dncCount }] = await Promise.all([
      supabase
        .from('twilio_configs')
        .select('account_sid, from_number, is_active, verified_at, last_error')
        .eq('account_id', accountId)
        .maybeSingle(),
      supabase.from('profiles').select('phone').eq('user_id', userId).maybeSingle(),
      supabase
        .from('do_not_call')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId),
    ])

    // `auth_token` is deliberately absent from the select above — a
    // separate existence check keeps the ciphertext off the wire.
    const { count: tokenCount } = await supabase
      .from('twilio_configs')
      .select('account_id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .not('auth_token', 'is', null)

    return NextResponse.json({
      configured: !!config,
      account_sid: config?.account_sid ?? null,
      from_number: config?.from_number ?? null,
      is_active: config?.is_active ?? false,
      verified_at: config?.verified_at ?? null,
      last_error: config?.last_error ?? null,
      has_auth_token: (tokenCount ?? 0) > 0,
      // The advisor's own bridge target — per-user, not per-account.
      advisor_phone: profile?.phone ?? null,
      do_not_call_count: dncCount ?? 0,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`calls-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as {
      account_sid?: unknown
      auth_token?: unknown
      from_number?: unknown
      advisor_phone?: unknown
      is_active?: unknown
    } | null

    const accountSid =
      typeof body?.account_sid === 'string' ? body.account_sid.trim() : undefined
    const authToken =
      typeof body?.auth_token === 'string' && body.auth_token.trim()
        ? body.auth_token.trim()
        : undefined
    const fromNumber =
      typeof body?.from_number === 'string' ? body.from_number.trim() : undefined

    // The advisor's bridge number updates the CALLER's own profile —
    // it's per-user, and nobody edits someone else's here.
    if (typeof body?.advisor_phone === 'string') {
      const phone = body.advisor_phone.trim()
      const { error } = await supabase
        .from('profiles')
        .update({ phone: phone || null })
        .eq('user_id', userId)
      if (error) {
        console.error('[calls/config] advisor phone update failed:', error)
        return NextResponse.json(
          { error: 'No se pudo guardar el teléfono del asesor' },
          { status: 500 },
        )
      }
    }

    // Nothing else to do if only the phone was submitted.
    if (accountSid === undefined && authToken === undefined && fromNumber === undefined) {
      return NextResponse.json({ success: true })
    }

    const { data: existing } = await supabase
      .from('twilio_configs')
      .select('account_sid, auth_token, from_number')
      .eq('account_id', accountId)
      .maybeSingle()

    // Blank secret means "keep what's stored" — the UI never echoes it
    // back, so re-saving other fields must not wipe it.
    const nextSid = accountSid ?? existing?.account_sid ?? null
    const nextFrom = fromNumber ?? existing?.from_number ?? null
    const nextTokenCipher = authToken
      ? encrypt(authToken)
      : (existing?.auth_token as string | null) ?? null

    if (!nextSid || !nextFrom || !nextTokenCipher) {
      return NextResponse.json(
        { error: 'Account SID, Auth Token y número de origen son requeridos.' },
        { status: 400 },
      )
    }

    // Verify against Twilio before storing a "verified" stamp. A bad
    // credential is far cheaper to catch here than mid-campaign.
    let verifiedAt: string | null = null
    let lastError: string | null = null
    try {
      const result = await validateTwilioCredentials({
        accountSid: nextSid,
        authToken: decrypt(nextTokenCipher),
        fromNumber: nextFrom,
      })
      if (result.ok) verifiedAt = new Date().toISOString()
      else lastError = result.error
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Error al verificar con Twilio'
    }

    const { error } = await supabase.from('twilio_configs').upsert(
      {
        account_id: accountId,
        user_id: userId,
        account_sid: nextSid,
        auth_token: nextTokenCipher,
        from_number: nextFrom,
        is_active: typeof body?.is_active === 'boolean' ? body.is_active : true,
        verified_at: verifiedAt,
        last_error: lastError,
      },
      { onConflict: 'account_id' },
    )
    if (error) {
      console.error('[calls/config] upsert failed:', error)
      return NextResponse.json({ error: 'No se pudo guardar' }, { status: 500 })
    }

    // Saved either way; `verified` tells the UI whether it can dial.
    return NextResponse.json({
      success: true,
      verified: !!verifiedAt,
      warning: lastError ?? undefined,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase
      .from('twilio_configs')
      .delete()
      .eq('account_id', accountId)
    if (error) {
      return NextResponse.json({ error: 'No se pudo eliminar' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
