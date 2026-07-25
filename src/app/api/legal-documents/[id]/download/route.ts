import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/legal-documents/[id]/download  (agent+)
 *
 * The download lock from the report: the advisor cannot download the
 * Minuta while it's "pendiente" or "rechazada" — only once gerencia
 * flips it to "listo_para_firma" does this route let the request
 * through. Anexo 01/02 are working drafts and stay freely
 * downloadable at any status. Redirects to the public Storage URL
 * rather than streaming the bytes, since `reservation-docs` is a
 * public bucket already.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params

    const { data: doc, error } = await supabase
      .from('legal_documents')
      .select('doc_type, status, pdf_url')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (error || !doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }
    if (!doc.pdf_url) {
      return NextResponse.json({ error: 'Document has not been generated yet' }, { status: 404 })
    }
    if (doc.doc_type === 'minuta' && doc.status !== 'listo_para_firma') {
      return NextResponse.json(
        {
          error:
            'La minuta aún no está lista para firma. Debe ser aprobada por gerencia antes de poder descargarse.',
        },
        { status: 403 },
      )
    }

    return NextResponse.redirect(doc.pdf_url)
  } catch (err) {
    return toErrorResponse(err)
  }
}
