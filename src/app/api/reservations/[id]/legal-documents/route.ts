import { NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { Anexo01Document } from '@/lib/legal/pdf/anexo-01-document'
import { Anexo02Document } from '@/lib/legal/pdf/anexo-02-document'
import { MinutaDocument } from '@/lib/legal/pdf/minuta-document'
import type {
  Anexo01Data,
  Anexo02Data,
  Contact,
  LegalDocType,
  RealEstateProject,
  RealEstateUnit,
} from '@/types'

/**
 * GET /api/reservations/[id]/legal-documents  (agent+)
 *
 * List the legal documents generated so far for one reservation —
 * powers the 3-card panel in the reservation detail sheet.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id: reservationId } = await params

    const { data, error } = await supabase
      .from('legal_documents')
      .select('*')
      .eq('reservation_id', reservationId)
      .eq('account_id', accountId)
    if (error) {
      console.error('[legal-documents GET] error:', error)
      return NextResponse.json({ error: 'Failed to load documents' }, { status: 500 })
    }
    return NextResponse.json({ documents: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/reservations/[id]/legal-documents  (agent+)
 *
 * Generate (or re-generate) one document for the reservation:
 *   - anexo_01 / anexo_02: body.data is the form payload, validated
 *     minimally and rendered directly.
 *   - minuta: no body.data — it's assembled server-side from the
 *     reservation's own anexo_01 + anexo_02 rows (both must already
 *     exist), plus the project's seller_* fields, which is what
 *     makes the same template adapt per project without an if/else
 *     on project name.
 *
 * Always resets status to 'pendiente' — a re-generated document is a
 * new draft that needs gerencia's eyes again, even if the previous
 * version was already approved.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`legal-doc:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id: reservationId } = await params
    const body = await request.json().catch(() => null)
    const docType = body?.doc_type as LegalDocType | undefined
    if (!docType || !['anexo_01', 'anexo_02', 'minuta'].includes(docType)) {
      return NextResponse.json({ error: 'doc_type must be anexo_01, anexo_02, or minuta' }, { status: 400 })
    }

    const { data: reservation, error: resErr } = await supabase
      .from('reservations')
      .select('*, contact:contacts(*), reservation_units(unit:real_estate_units(*))')
      .eq('id', reservationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (resErr || !reservation) {
      return NextResponse.json({ error: 'Reservation not found' }, { status: 404 })
    }

    const units = ((reservation as { reservation_units?: { unit: RealEstateUnit }[] })
      .reservation_units ?? []
    )
      .map((ru) => ru.unit)
      .filter(Boolean) as RealEstateUnit[]
    if (units.length === 0) {
      return NextResponse.json({ error: 'Reservation has no linked units' }, { status: 400 })
    }
    const contact = reservation.contact as Contact | null

    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle()
    const createdBy = profile?.id ?? null

    let pdfBuffer: Buffer
    let storedData: Record<string, unknown>

    if (docType === 'anexo_01') {
      const data = body?.data as Anexo01Data | undefined
      if (!data?.comprador?.nombre) {
        return NextResponse.json({ error: 'data.comprador.nombre is required' }, { status: 400 })
      }
      pdfBuffer = await renderToBuffer(
        Anexo01Document({
          data,
          units,
          projectName: units[0]?.project_id ? await projectName(supabase, units[0].project_id) : '',
          reservationDate: new Date(reservation.created_at).toLocaleDateString('es-PE'),
        }),
      )
      storedData = data as unknown as Record<string, unknown>
    } else if (docType === 'anexo_02') {
      const data = body?.data as Anexo02Data | undefined
      if (!data || !Array.isArray(data.cuotas)) {
        return NextResponse.json({ error: 'data.cuotas is required' }, { status: 400 })
      }
      const { data: anexo01Row } = await supabase
        .from('legal_documents')
        .select('data')
        .eq('reservation_id', reservationId)
        .eq('doc_type', 'anexo_01')
        .maybeSingle()
      const buyerName =
        (anexo01Row?.data as Anexo01Data | undefined)?.comprador?.nombre ||
        contact?.name ||
        contact?.phone ||
        '—'
      pdfBuffer = await renderToBuffer(
        Anexo02Document({ data, currency: units[0]?.currency ?? 'PEN', buyerName }),
      )
      storedData = data as unknown as Record<string, unknown>
    } else {
      const [{ data: anexo01Row }, { data: anexo02Row }] = await Promise.all([
        supabase
          .from('legal_documents')
          .select('data')
          .eq('reservation_id', reservationId)
          .eq('doc_type', 'anexo_01')
          .maybeSingle(),
        supabase
          .from('legal_documents')
          .select('data')
          .eq('reservation_id', reservationId)
          .eq('doc_type', 'anexo_02')
          .maybeSingle(),
      ])
      if (!anexo01Row || !anexo02Row) {
        return NextResponse.json(
          { error: 'Genera primero el Anexo 01 y el Anexo 02 antes de la Minuta.' },
          { status: 400 },
        )
      }
      const anexo01 = anexo01Row.data as Anexo01Data
      const anexo02 = anexo02Row.data as Anexo02Data

      const { data: project, error: projErr } = await supabase
        .from('real_estate_projects')
        .select('*')
        .eq('id', units[0].project_id)
        .maybeSingle()
      if (projErr || !project) {
        return NextResponse.json({ error: 'Project not found for this unit' }, { status: 404 })
      }

      pdfBuffer = await renderToBuffer(
        MinutaDocument({
          project: project as RealEstateProject,
          units,
          anexo01,
          anexo02,
          fechaMinuta: new Date().toLocaleDateString('es-PE', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          }),
          ciudad: (project as RealEstateProject).city || 'Ica',
        }),
      )
      storedData = { anexo01, anexo02 }
    }

    const path = `account-${accountId}/legal/${reservationId}/${docType}-${Date.now()}.pdf`
    const { error: uploadErr } = await supabase.storage
      .from('reservation-docs')
      .upload(path, pdfBuffer, { contentType: 'application/pdf', upsert: false })
    if (uploadErr) {
      console.error('[legal-documents POST] upload error:', uploadErr)
      return NextResponse.json({ error: 'Failed to store generated PDF' }, { status: 500 })
    }
    const {
      data: { publicUrl },
    } = supabase.storage.from('reservation-docs').getPublicUrl(path)

    const { data: doc, error: upsertErr } = await supabase
      .from('legal_documents')
      .upsert(
        {
          account_id: accountId,
          reservation_id: reservationId,
          doc_type: docType,
          data: storedData,
          status: 'pendiente',
          pdf_url: publicUrl,
          created_by: createdBy,
          reviewed_by: null,
          reviewed_at: null,
        },
        { onConflict: 'reservation_id,doc_type' },
      )
      .select('*')
      .single()
    if (upsertErr || !doc) {
      console.error('[legal-documents POST] upsert error:', upsertErr)
      return NextResponse.json({ error: 'Failed to save document record' }, { status: 500 })
    }

    return NextResponse.json({ success: true, document: doc })
  } catch (err) {
    return toErrorResponse(err)
  }
}

async function projectName(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  projectId: string,
): Promise<string> {
  const { data } = await supabase
    .from('real_estate_projects')
    .select('name')
    .eq('id', projectId)
    .maybeSingle()
  return data?.name ?? ''
}
