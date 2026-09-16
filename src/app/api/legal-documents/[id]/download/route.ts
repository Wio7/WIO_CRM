import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * GET /api/legal-documents/[id]/download  (agent+)
 *
 * The download lock from the report: the advisor cannot download the
 * Minuta while it's "pendiente" or "rechazada" — only once gerencia
 * flips it to "listo_para_firma" does this route let the request
 * through. Anexo 01/02 are working drafts and stay freely
 * downloadable at any status.
 *
 * Since migration 042 the PDFs live in the private `client-docs`
 * bucket, so this route mints a short-lived signed URL and redirects to
 * it instead of streaming the bytes. Documents generated before that
 * migration stored a full public URL; those are redirected as they are.
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

    if (/^https?:\/\//i.test(doc.pdf_url)) {
      return NextResponse.redirect(doc.pdf_url)
    }

    const { data: firmado, error: signErr } = await supabase.storage
      .from('client-docs')
      .createSignedUrl(doc.pdf_url, 120)
    if (signErr || !firmado?.signedUrl) {
      console.error('[legal-documents download] sign error:', signErr)
      return NextResponse.json(
        { error: 'No se pudo preparar la descarga del documento' },
        { status: 500 },
      )
    }
    return NextResponse.redirect(firmado.signedUrl)
  } catch (err) {
    return toErrorResponse(err)
  }
}
