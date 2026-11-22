import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { notifyUsers } from '@/lib/push/send'

/**
 * Aviso diario (8:00 am de Lima) de separaciones que pasaron 7 días sin
 * completar la inicial (migración 109). Le llega a quienes deciden si se
 * libera el lote. No manda datos del cliente, sólo la cantidad.
 *
 * Auth igual que /api/caja/resumen-whatsapp: `x-cron-secret` o el Bearer de
 * Vercel Cron.
 */
export const maxDuration = 60

const DIAS = 7
const URL_APROBACIONES = 'https://gerencia-golden.vercel.app/aprobaciones'

function secretMatches(supplied: string, expected: string | undefined): boolean {
  if (!expected) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

interface FilaAviso {
  account_id: string
  cantidad: number
  destinatarios: string[] | null
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
  const { data, error } = await db.rpc('gh_por_vencer_aviso', { p_dias: DIAS })
  if (error) {
    console.error(
      '[separaciones por vencer] falló gh_por_vencer_aviso (¿falta correr la migración 109?):',
      error.message
    )
    return NextResponse.json({ ok: false }, { status: 500 })
  }

  let cuentas = 0
  let enviados = 0
  for (const fila of (data ?? []) as FilaAviso[]) {
    const destinatarios = fila.destinatarios ?? []
    if (!(fila.cantidad > 0) || destinatarios.length === 0) continue
    cuentas += 1
    const n = fila.cantidad
    enviados += await notifyUsers(db, {
      userIds: destinatarios,
      title: 'Separaciones por vencer',
      body: `${n} ${n === 1 ? 'separación pasó' : 'separaciones pasaron'} ${DIAS} días sin completar la inicial. Revisa y decide si liberar.`,
      url: URL_APROBACIONES,
      tag: 'golden-por-vencer',
    })
  }

  return NextResponse.json({ ok: true, cuentas, enviados })
}
