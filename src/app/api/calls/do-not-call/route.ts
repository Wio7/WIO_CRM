// ============================================================
// GET/POST/DELETE /api/calls/do-not-call
//
// The account's exclusion list, checked before every dial.
//
// In Peru, Indecopi maintains the "Gracias, no insista" registry.
// It has NO public API — it's a consultation/download — so this is an
// IMPORTED list, not a live lookup. The settings UI says so plainly;
// nobody should assume it syncs itself.
//
// Numbers are stored digits-only (`normalizePhone`), matching the
// generated `contacts.phone_normalized` column from migration 022, so
// the pre-dial cross-check is an exact comparison rather than a fuzzy
// one.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'

const MAX_IMPORT = 5000

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const search = new URL(request.url).searchParams.get('search')?.trim()

    let query = supabase
      .from('do_not_call')
      .select('id, phone_normalized, source, notes, added_at', { count: 'exact' })
      .eq('account_id', accountId)
      .order('added_at', { ascending: false })
      .limit(100)

    if (search) {
      query = query.ilike('phone_normalized', `%${normalizePhone(search)}%`)
    }

    const { data, count, error } = await query
    if (error) {
      console.error('[do-not-call GET] error:', error)
      return NextResponse.json({ error: 'No se pudo cargar la lista' }, { status: 500 })
    }
    return NextResponse.json({ entries: data ?? [], total: count ?? 0 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * Body: `{ phones: string[], source?: string, notes?: string }`.
 *
 * Upsert-ignore on the (account_id, phone_normalized) unique index, so
 * re-importing the same list is a no-op instead of an error — the
 * common case is an operator re-uploading a refreshed export.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`dnc-import:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as {
      phones?: unknown
      source?: unknown
      notes?: unknown
    } | null

    if (!Array.isArray(body?.phones)) {
      return NextResponse.json({ error: 'phones debe ser un arreglo' }, { status: 400 })
    }

    const source = typeof body.source === 'string' ? body.source.trim() : 'importacion'
    const notes = typeof body.notes === 'string' ? body.notes.trim() || null : null

    // Normalize, drop blanks and anything implausibly short, dedupe.
    const normalized = new Set<string>()
    for (const raw of body.phones) {
      if (typeof raw !== 'string') continue
      const digits = normalizePhone(raw)
      if (digits.length >= 6) normalized.add(digits)
    }

    if (normalized.size === 0) {
      return NextResponse.json(
        { error: 'No se encontró ningún número válido en el archivo.' },
        { status: 400 },
      )
    }
    if (normalized.size > MAX_IMPORT) {
      return NextResponse.json(
        { error: `Máximo ${MAX_IMPORT} números por importación.` },
        { status: 400 },
      )
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle()

    const rows = Array.from(normalized).map((phone) => ({
      account_id: accountId,
      phone_normalized: phone,
      source,
      notes,
      added_by: profile?.id ?? null,
    }))

    const { error } = await supabase
      .from('do_not_call')
      .upsert(rows, { onConflict: 'account_id,phone_normalized', ignoreDuplicates: true })
    if (error) {
      console.error('[do-not-call POST] upsert failed:', error)
      return NextResponse.json({ error: 'No se pudo importar la lista' }, { status: 500 })
    }

    const { count } = await supabase
      .from('do_not_call')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)

    return NextResponse.json({ success: true, imported: rows.length, total: count ?? 0 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const id = new URL(request.url).searchParams.get('id')
    if (!id) {
      return NextResponse.json({ error: 'id es requerido' }, { status: 400 })
    }
    const { error } = await supabase
      .from('do_not_call')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
    if (error) {
      return NextResponse.json({ error: 'No se pudo eliminar' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
