import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendTemplateMessage, sendTextMessage } from '@/lib/whatsapp/meta-api'
import { comoLaPersona } from '@/lib/asistentes-whatsapp/caja'
import {
  MARCA_CAJA,
  hoyEnLima,
  recortar,
  resumenDelDia,
  soles,
  type VistaDelDia,
} from '@/lib/asistentes-whatsapp/texto'

/**
 * El resumen nocturno de Golden Caja por WhatsApp (9:00 pm de Lima).
 *
 * Le llega a cada dueño de caja de las organizaciones con el modo equipo
 * encendido (whatsapp_team_accounts, migración 075) que tenga su celular en
 * el perfil. El resumen se arma COMO esa persona (cash_as_user), así que ve
 * lo mismo que en la app.
 *
 * WhatsApp sólo deja mandar texto libre dentro de las 24 horas desde el
 * último mensaje de la persona. Fuera de esa ventana hace falta una
 * plantilla aprobada por Meta: si WA_PLANTILLA_RESUMEN_CAJA tiene su
 * nombre, se manda esa (con la fecha y el total); si no, ese día no se le
 * manda nada y queda en el log.
 *
 * Auth igual que /api/calls/cron: `x-cron-secret` o el Bearer de Vercel Cron.
 */
export const maxDuration = 60

const VENTANA_MS = 24 * 60 * 60 * 1000

function secretMatches(supplied: string, expected: string | undefined): boolean {
  if (!expected) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

interface Destinatario {
  account_id: string
  user_id: string
  name: string
  phone: string
  last_inbound_at: string | null
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
  const { data, error } = await db.rpc('whatsapp_team_digest_recipients')
  if (error) {
    console.error('[resumen caja] no se pudo leer a quién mandar:', error.message)
    return NextResponse.json({ error: 'query failed' }, { status: 500 })
  }
  const destinatarios = (data ?? []) as Destinatario[]
  const plantilla = process.env.WA_PLANTILLA_RESUMEN_CAJA?.trim()
  const hoy = hoyEnLima()
  const fecha = new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date())

  const numeros = new Map<string, { phoneNumberId: string; accessToken: string } | null>()
  const resultado = { enviados: 0, con_plantilla: 0, fuera_de_ventana: 0, fallidos: 0 }

  for (const d of destinatarios) {
    try {
      if (!numeros.has(d.account_id)) {
        const { data: config } = await db
          .from('whatsapp_config')
          .select('phone_number_id, access_token')
          .eq('account_id', d.account_id)
          .limit(1)
          .maybeSingle()
        numeros.set(
          d.account_id,
          config ? { phoneNumberId: config.phone_number_id, accessToken: decrypt(config.access_token) } : null,
        )
      }
      const numero = numeros.get(d.account_id)
      if (!numero) continue

      const vista = await comoLaPersona<VistaDelDia>({ db, userId: d.user_id }, 'overview', { day: hoy })
      if (!vista.boxes.length) continue

      const dentroDeVentana =
        !!d.last_inbound_at && Date.now() - new Date(d.last_inbound_at).getTime() < VENTANA_MS
      if (dentroDeVentana) {
        const saludo = `Buenas noches, ${d.name}. Así cerró el ${fecha}:`
        await sendTextMessage({
          ...numero,
          to: d.phone,
          text: recortar(`${MARCA_CAJA}\n${resumenDelDia(vista, saludo)}`, 4096),
        })
        resultado.enviados += 1
      } else if (plantilla) {
        // Las variables de una plantilla no aceptan saltos de línea: va la
        // fecha y el total; el detalle llega al tocar el botón.
        const entro = vista.boxes.reduce((s, c) => s + c.inCents, 0)
        const salio = vista.boxes.reduce((s, c) => s + c.outCents, 0)
        await sendTemplateMessage({
          ...numero,
          to: d.phone,
          templateName: plantilla,
          language: process.env.WA_PLANTILLA_RESUMEN_CAJA_IDIOMA?.trim() || 'es',
          params: [fecha, `entró ${soles(entro)} y salió ${soles(salio)}`],
        })
        resultado.con_plantilla += 1
      } else {
        resultado.fuera_de_ventana += 1
        console.warn('[resumen caja] fuera de la ventana de 24 h y sin plantilla:', d.user_id)
      }
    } catch (err) {
      resultado.fallidos += 1
      console.error('[resumen caja] no se pudo mandar a', d.user_id, err)
    }
  }

  return NextResponse.json({ ok: true, ...resultado })
}
