import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import type { LegalDocStatus } from '@/types'

const VALID_STATUSES: LegalDocStatus[] = [
  'pendiente',
  'aprobado',
  'rechazado',
  'listo_para_firma',
]

/**
 * PATCH /api/legal-documents/[id]/status  (admin+)
 *
 * Gerencia's approval action — approve/reject a document, or (only
 * for doc_type "minuta") mark it "listo_para_firma", which is what
 * unlocks the download endpoint. Admin+ only, matching the report:
 * the advisor generates drafts, only gerencia decides their status.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`legal-doc-status:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    const status = body?.status as LegalDocStatus | undefined
    if (!status || !VALID_STATUSES.includes(status)) {
      return NextResponse.json(
        { error: `status must be one of: ${VALID_STATUSES.join(', ')}` },
        { status: 400 },
      )
    }

    const { data: doc, error: fetchErr } = await supabase
      .from('legal_documents')
      .select('id, doc_type, account_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (fetchErr || !doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }
    if (status === 'listo_para_firma' && doc.doc_type !== 'minuta') {
      return NextResponse.json(
        { error: '"listo_para_firma" only applies to the minuta' },
        { status: 400 },
      )
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle()

    const { data: updated, error: updateErr } = await supabase
      .from('legal_documents')
      .update({
        status,
        reviewed_by: profile?.id ?? null,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single()
    if (updateErr || !updated) {
      console.error('[legal-documents status PATCH] error:', updateErr)
      return NextResponse.json({ error: 'Failed to update status' }, { status: 500 })
    }

    return NextResponse.json({ success: true, document: updated })
  } catch (err) {
    return toErrorResponse(err)
  }
}
