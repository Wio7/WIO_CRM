// ============================================================
// Cuando el asesor le devuelve la conversación a la IA.
//
// Antes, devolvérsela significaba sólo dejarla encendida: la IA se
// quedaba esperando a que el cliente escribiera otra vez, y si el cliente
// no escribía, la conversación se moría ahí. Que es justo donde se
// pierden — el asesor cerró lo suyo ("ya te agendé la visita"), pasó a
// otra cosa, y nadie volvió a preguntar nada.
//
// Ahora la IA retoma ella: manda un mensaje que continúa la conversación
// donde se quedó ("¿qué tal fue la visita?", "¿pudiste ver lo que te
// mandó Sara?") y, si la cuenta la deja agendar (058), vuelve a ofrecer
// hora. Un mensaje, no dos: retomar no es empezar de cero.
// ============================================================

import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { diasLibres, equipoQuePuedeAgendar } from '@/lib/agenda/slots'
import { agendaEnTexto } from '@/lib/agenda/reservar'
import { catalogoDeGolden, catalogoEnTexto, sinCatalogoPegado } from '@/lib/golden/catalogo'
import { engineSendText } from '@/lib/flows/meta-send'

/**
 * El primer mensaje de la IA al recuperar un hilo. Nunca lanza: si algo
 * falla, el cliente se queda con el aviso de "te dejo con la asistente"
 * que ya salió, que es lo que había antes de esto.
 *
 * @returns true si llegó a mandar algo.
 */
export async function retomarConLaIa(args: {
  accountId: string
  conversationId: string
}): Promise<boolean> {
  const { accountId, conversationId } = args
  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return false

    const [{ data: conv }, { data: cuenta }] = await Promise.all([
      db
        .from('conversations')
        .select('contact_id, ai_autoreply_disabled')
        .eq('id', conversationId)
        .eq('account_id', accountId)
        .maybeSingle(),
      db
        .from('accounts')
        .select('owner_user_id, ai_books_appointments')
        .eq('id', accountId)
        .maybeSingle(),
    ])
    // Entre que se tocó el botón y esto, alguien pudo volver a tomarla.
    if (!conv?.contact_id || conv.ai_autoreply_disabled) return false
    if (!cuenta?.owner_user_id) return false
    const contactId = conv.contact_id as string

    const messages = await buildConversationContext(db, conversationId)
    if (!messages.length) return false

    let agenda: { horasLibres: string; nombreDelCliente: string | null } | null = null
    if (cuenta.ai_books_appointments) {
      const equipo = await equipoQuePuedeAgendar(db, accountId, contactId)
      const [dias, { data: contacto }] = await Promise.all([
        equipo.length ? diasLibres(db, accountId, equipo) : Promise.resolve([]),
        db.from('contacts').select('name').eq('id', contactId).maybeSingle(),
      ])
      const nombre = ((contacto?.name as string | null) ?? '').trim()
      agenda = {
        horasLibres: agendaEnTexto(dias),
        nombreDelCliente: nombre && !/^cliente de /i.test(nombre) ? nombre : null,
      }
    }

    const catalogo = await catalogoDeGolden()
    const instrucciones = catalogo ? sinCatalogoPegado(config.systemPrompt) : config.systemPrompt

    const { text } = await generateReply({
      config,
      systemPrompt: buildSystemPrompt({
        userPrompt: [instrucciones, INSTRUCCION].filter(Boolean).join('\n\n'),
        mode: 'auto_reply',
        agenda,
        nuncaSeCalla: true,
        catalogo: catalogo ? catalogoEnTexto(catalogo) : null,
      }),
      messages,
    })
    if (!text) return false

    await engineSendText({
      accountId,
      userId: cuenta.owner_user_id as string,
      conversationId,
      contactId,
      text,
    })
    return true
  } catch (err) {
    console.error('[ai retomar] no se pudo retomar la conversación:', err)
    return false
  }
}

const INSTRUCCION = [
  'RETOMAS TÚ LA CONVERSACIÓN.',
  'Un asesor acaba de devolverte este chat. Al cliente ya se le avisó de que vuelves tú: no lo repitas, no te presentes de nuevo y no le des las gracias por esperar.',
  'Escribe UN solo mensaje corto que continúe justo donde se quedó la conversación: retoma lo último que se habló y haz una pregunta concreta que la mueva ("¿qué tal fue la visita?", "¿pudiste revisar lo que te pasó el asesor?", "¿te confirmaron la hora?").',
  'No preguntes en qué puedes ayudar, que es empezar de cero, y no menciones al asesor como alguien a quien haya que volver a llamar.',
  'Si ya había una cita agendada, pregunta por ella. Si no la hubo y el cliente seguía buscando, vuelve a ofrecerle hora.',
].join('\n')
