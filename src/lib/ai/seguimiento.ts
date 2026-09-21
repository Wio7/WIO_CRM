// ============================================================
// Al que deja de contestar, se le vuelve a escribir (059).
//
// El caso real: alguien llega de una campaña, pregunta el precio, le
// contestamos bien... y se va a comer. No vuelve. Esa conversación se
// moría sola, y a las 24 horas WhatsApp ya no deja escribirle sin
// plantilla: el lead se pierde entero, habiéndolo pagado.
//
// Aquí se le insiste cuatro veces —a la hora, a las tres, a las seis y
// una última antes de que se cierre la ventana— y siempre siguiendo el
// hilo: se le vuelve a escribir sobre lo que se estaba hablando, no con
// un "¿sigues ahí?". A la tercera le suena el celular al asesor, porque a
// las seis horas de silencio ya toca que escriba una persona.
//
// Los relojes se cuentan desde el ÚLTIMO MENSAJE DEL CLIENTE, no desde el
// nuestro. Es el mismo ancla que usa WhatsApp para su ventana de 24 h, y
// es lo que hace que los cuatro toques quepan dentro de ella.
//
// Lo llama el cron de recordatorios, que corre cada pocos minutos.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { diasLibres, equipoQuePuedeAgendar } from '@/lib/agenda/slots'
import { agendaEnTexto } from '@/lib/agenda/reservar'
import { catalogoDeGolden, catalogoEnTexto, sinCatalogoPegado } from '@/lib/golden/catalogo'
import { engineSendText } from '@/lib/flows/meta-send'
import { notifyConversation } from '@/lib/push/send'

/** Minutos de silencio tras los que toca cada toque. */
const PASOS = [60, 180, 360, 1380] as const // 1 h · 3 h · 6 h · 23 h

/** A partir del tercero, el asesor se entera. */
const PASO_QUE_AVISA = 2

/** Hora de Lima en la que se puede escribir. Nadie vende a las 4 a. m. */
const DESDE_HORA = 8
const HASTA_HORA = 21

/** Dos toques no pueden salir pegados aunque el cron se repita. */
const MINIMO_ENTRE_TOQUES_MIN = 45

const LIMA = 'America/Lima'

/** La hora de Lima ahora mismo, 0–23. */
function horaEnLima(): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: LIMA, hour: '2-digit', hour12: false }).format(new Date()),
  )
}

interface Candidata {
  id: string
  account_id: string
  contact_id: string | null
  followup_count: number
  followup_last_at: string | null
}

export interface ResultadoSeguimiento {
  escritos: number
  avisados: number
  motivo?: string
}

/**
 * Una pasada completa: mira qué conversaciones llevan demasiado tiempo
 * calladas y le escribe a cada una. Nunca lanza — es parte de un cron que
 * hace más cosas, y que falle esto no puede tumbar los recordatorios de
 * citas ni los de cuotas.
 */
export async function seguimientosPendientes(db: SupabaseClient): Promise<ResultadoSeguimiento> {
  try {
    if (horaEnLima() < DESDE_HORA || horaEnLima() >= HASTA_HORA) {
      return { escritos: 0, avisados: 0, motivo: 'fuera de hora' }
    }

    const { data: cuentas, error } = await db
      .from('accounts')
      .select('id, ai_follows_up')
      .eq('ai_follows_up', true)
    // Sin la 059 la columna no existe: no es un error, es que todavía no toca.
    if (error || !cuentas?.length) return { escritos: 0, avisados: 0, motivo: error ? 'sin 059' : 'ninguna cuenta' }

    let escritos = 0
    let avisados = 0
    for (const cuenta of cuentas) {
      const r = await deUnaCuenta(db, cuenta.id as string)
      escritos += r.escritos
      avisados += r.avisados
    }
    return { escritos, avisados }
  } catch (err) {
    console.error('[seguimiento] la pasada falló:', err)
    return { escritos: 0, avisados: 0, motivo: 'error' }
  }
}

async function deUnaCuenta(db: SupabaseClient, accountId: string): Promise<ResultadoSeguimiento> {
  const config = await loadAiConfig(db, accountId).catch(() => null)
  if (!config || !config.autoReplyEnabled) return { escritos: 0, avisados: 0 }

  // Sólo lo vivo: nada de hace más de un día, que ya está fuera de la
  // ventana de WhatsApp y no se puede escribir igual.
  const desde = new Date(Date.now() - 25 * 60 * 60_000).toISOString()
  const { data, error } = await db
    .from('conversations')
    .select('id, account_id, contact_id, followup_count, followup_last_at')
    .eq('account_id', accountId)
    .eq('ai_autoreply_disabled', false)
    .gte('last_message_at', desde)
    .lt('followup_count', PASOS.length)
    .limit(200)
  if (error || !data?.length) return { escritos: 0, avisados: 0 }

  let escritos = 0
  let avisados = 0
  for (const conv of data as unknown as Candidata[]) {
    const r = await unaConversacion(db, conv, config)
    if (r.escrito) escritos += 1
    if (r.avisado) avisados += 1
  }
  return { escritos, avisados }
}

async function unaConversacion(
  db: SupabaseClient,
  conv: Candidata,
  config: NonNullable<Awaited<ReturnType<typeof loadAiConfig>>>,
): Promise<{ escrito: boolean; avisado: boolean }> {
  const nada = { escrito: false, avisado: false }
  if (!conv.contact_id) return nada

  // Dos toques seguidos, no.
  if (conv.followup_last_at && Date.now() - Date.parse(conv.followup_last_at) < MINIMO_ENTRE_TOQUES_MIN * 60_000) {
    return nada
  }

  // El ancla: lo último que dijo el cliente. Y lo último que se dijo, sea
  // de quien sea — si el último mensaje es suyo, no hay nada que seguir:
  // le toca contestar a la IA por su camino normal, no por aquí.
  const { data: ultimos } = await db
    .from('messages')
    .select('sender_type, created_at')
    .eq('conversation_id', conv.id)
    .order('created_at', { ascending: false })
    .limit(30)
  if (!ultimos?.length) return nada
  if (ultimos[0].sender_type === 'customer') return nada

  const delCliente = ultimos.find((m) => m.sender_type === 'customer')
  if (!delCliente) return nada // nunca escribió: no es un lead, es un envío nuestro

  const silencioMin = (Date.now() - Date.parse(delCliente.created_at as string)) / 60_000
  const paso = conv.followup_count
  if (paso >= PASOS.length || silencioMin < PASOS[paso]) return nada

  // Si ya tiene cita, no se le persigue: ya hizo lo que queríamos.
  const { count } = await db
    .from('appointments')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', conv.contact_id)
    .eq('status', 'agendada')
    .gte('starts_at', new Date().toISOString())
  if ((count ?? 0) > 0) return nada

  const texto = await redactarToque(db, {
    accountId: conv.account_id,
    conversationId: conv.id,
    contactId: conv.contact_id,
    config,
    paso,
    silencioMin,
  })
  if (!texto) return nada

  // Se apunta ANTES de mandar. Si el envío falla se pierde un toque; si
  // se apuntara después y el proceso se cortara, el cliente recibiría el
  // mismo mensaje en cada pasada. Insistir de más es peor que de menos.
  await db
    .from('conversations')
    .update({ followup_count: paso + 1, followup_last_at: new Date().toISOString() })
    .eq('id', conv.id)

  const { data: cuenta } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', conv.account_id)
    .maybeSingle()

  try {
    await engineSendText({
      accountId: conv.account_id,
      userId: (cuenta?.owner_user_id as string) ?? '',
      conversationId: conv.id,
      contactId: conv.contact_id,
      text: texto,
    })
  } catch (err) {
    console.error('[seguimiento] no se pudo escribir:', err)
    return nada
  }

  let avisado = false
  if (paso >= PASO_QUE_AVISA) {
    avisado = await avisarAlAsesor(db, conv, paso, silencioMin)
  }
  return { escrito: true, avisado }
}

/** El mensaje, escrito por la IA con el hilo delante. */
async function redactarToque(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    config: NonNullable<Awaited<ReturnType<typeof loadAiConfig>>>
    paso: number
    silencioMin: number
  },
): Promise<string | null> {
  const messages = await buildConversationContext(db, args.conversationId)
  if (!messages.length) return null

  const { data: cuenta } = await db
    .from('accounts')
    .select('ai_books_appointments')
    .eq('id', args.accountId)
    .maybeSingle()

  let agenda: { horasLibres: string; nombreDelCliente: string | null } | null = null
  if (cuenta?.ai_books_appointments) {
    const equipo = await equipoQuePuedeAgendar(db, args.accountId, args.contactId)
    const [dias, { data: contacto }] = await Promise.all([
      equipo.length ? diasLibres(db, args.accountId, equipo) : Promise.resolve([]),
      db.from('contacts').select('name').eq('id', args.contactId).maybeSingle(),
    ])
    const nombre = ((contacto?.name as string | null) ?? '').trim()
    agenda = {
      horasLibres: agendaEnTexto(dias),
      nombreDelCliente: nombre && !/^cliente de /i.test(nombre) ? nombre : null,
    }
  }

  const catalogo = await catalogoDeGolden()
  const instrucciones = catalogo ? sinCatalogoPegado(args.config.systemPrompt) : args.config.systemPrompt

  const { text } = await generateReply({
    config: args.config,
    systemPrompt: buildSystemPrompt({
      userPrompt: [instrucciones, instruccionDelToque(args.paso, args.silencioMin)].filter(Boolean).join('\n\n'),
      mode: 'auto_reply',
      agenda,
      nuncaSeCalla: true,
      catalogo: catalogo ? catalogoEnTexto(catalogo) : null,
    }),
    messages,
  })
  return text || null
}

function instruccionDelToque(paso: number, silencioMin: number): string {
  const horas = Math.round(silencioMin / 60)
  const comun = [
    'ESTÁS RETOMANDO TÚ, EL CLIENTE NO HA CONTESTADO.',
    `Lleva ${horas} hora(s) sin responder. Nadie te ha escrito: este mensaje sale por iniciativa tuya.`,
    'Escribe UN mensaje corto que siga el hilo de lo último que se habló. Nada de "¿sigues ahí?", "¿hola?" ni "¿en qué puedo ayudarte?": eso se lee como un robot insistiendo.',
    'No te disculpes por escribir, no digas que le escribes "de nuevo" ni cuentes cuántas veces lo has intentado.',
    'No uses el sello de agendar: nadie ha elegido una hora todavía.',
  ]
  const propio = [
    // 1 h
    'Retoma con lo que quedó a medias y hazle UNA pregunta fácil de contestar, de las que se responden con una palabra.',
    // 3 h
    'Dale un dato nuevo y concreto de lo que le interesaba —un precio, un tamaño, una facilidad de pago— y termina invitándole a ver el proyecto.',
    // 6 h
    'Ofrécele directamente dos horas concretas de la lista para una videollamada o una visita, y dile que sólo tiene que elegir una.',
    // 23 h
    'Es tu última oportunidad de escribirle libremente por hoy. Sé cálido y breve, déjale claro que sigues ahí cuando quiera, y dale una razón para contestar hoy mismo. No menciones ninguna ventana de tiempo ni ninguna limitación de WhatsApp.',
  ]
  return [...comun, propio[Math.min(paso, propio.length - 1)]].join('\n')
}

/** "Este no contesta: escríbele tú." */
async function avisarAlAsesor(
  db: SupabaseClient,
  conv: Candidata,
  paso: number,
  silencioMin: number,
): Promise<boolean> {
  const { data } = await db
    .from('conversations')
    .select('assigned_agent_id, contact:contacts(name, phone)')
    .eq('id', conv.id)
    .maybeSingle()
  const quien = data?.contact as unknown as { name?: string | null; phone?: string | null } | null
  const nombre = quien?.name || quien?.phone || 'Un cliente'
  const horas = Math.round(silencioMin / 60)
  const ultimo = paso >= PASOS.length - 1

  try {
    await notifyConversation(db, {
      accountId: conv.account_id,
      conversationId: conv.id,
      assignedAgentId: (data?.assigned_agent_id as string | null) ?? null,
      title: ultimo ? 'Se te va un cliente' : 'No te contesta',
      body: ultimo
        ? `${nombre} lleva ${horas} h sin responder y hoy ya no se le podrá escribir libremente. Si quieres recuperarlo, escríbele ahora.`
        : `${nombre} preguntó y lleva ${horas} h sin responder. La asistente ya le insistió: mejor escríbele tú.`,
    })
    return true
  } catch (err) {
    console.error('[seguimiento] aviso al asesor falló:', err)
    return false
  }
}
