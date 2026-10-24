import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'
import { normalizePhone } from './phone-utils'
import { parseMessageContent } from './message-content'
import { computeSyncStatus, dedupeMessages, isCoexistenceField, mapStateSync, mapSyncMessage, type SyncMessage, type SyncValue } from './coexistence-sync'

interface Dependencies {
  findContact(account: string, user: string, phone: string): Promise<{ contact: { id: string } } | null>
  findConversation(account: string, user: string, contact: string): Promise<{ conversation: { id: string } } | null>
}

// Rama sin llamadas a motores, envíos, notificaciones ni contadores de no leídos.
export async function processCoexistenceChange(db: SupabaseClient, field: string, value: SyncValue, deps: Dependencies) {
  if (!isCoexistenceField(field) || !value.metadata?.phone_number_id) return
  const { data: configs, error } = await db.from('whatsapp_config').select('*')
    .eq('phone_number_id', value.metadata.phone_number_id)
  if (error) throw error
  if (configs?.length !== 1) return
  const config = configs[0]
  const contactCache = new Map<string, string>()
  async function contactFor(phone: string) {
    const normalized = normalizePhone(phone)
    if (!normalized) return null
    if (contactCache.has(normalized)) return contactCache.get(normalized)!
    const result = await deps.findContact(config.account_id, config.user_id, normalized)
    if (!result) throw new Error('No se pudo resolver el contacto de coexistencia')
    contactCache.set(normalized, result.contact.id)
    return result.contact.id
  }
  if (field === 'smb_app_state_sync') {
    for (const contact of mapStateSync(value.state_sync ?? [])) {
      const id = await contactFor(contact.phone)
      if (id && contact.name) {
        const { error } = await db.rpc('coexistence_contact_name', {
          p_account: config.account_id, p_contact: id, p_name: contact.name,
        })
        if (error) throw error
      }
    }
    return
  }
  const source = field === 'history' ? 'phone_history' : 'phone_app'
  const threads = source === 'phone_history' ? (value.history ?? []).flatMap(chunk => chunk.threads ?? [])
    : Array.from((value.message_echoes ?? []).reduce((map, message) => {
      const phone = normalizePhone(message.to ?? '')
      if (phone) map.set(phone, [...(map.get(phone) ?? []), message])
      return map
    }, new Map<string, SyncMessage[]>()), ([id, messages]) => ({ id, messages }))
  try {
    for (const thread of threads) {
      const messages = dedupeMessages(thread.messages)
      if (!messages.length) continue
      const contactId = await contactFor(thread.id)
      if (!contactId) continue
      const result = await deps.findConversation(config.account_id, config.user_id, contactId)
      if (!result) throw new Error('No se pudo resolver la conversación de coexistencia')
      for (let offset = 0; offset < messages.length; offset += 200) {
        const batch = messages.slice(offset, offset + 200)
        const rows = await Promise.all(batch.map(async message => mapSyncMessage(message, result.conversation.id,
          value.metadata!.display_phone_number, source, source === 'phone_app'
            ? await parseMessageContent(message, decrypt(config.access_token)) : undefined)))
        const { error } = await db.rpc('coexistence_insert_messages', {
          p_account: config.account_id, p_conversation: result.conversation.id, p_rows: rows.filter(row => row !== null),
        })
        if (error) throw error
      }
    }
    if (field === 'history') {
      const status = computeSyncStatus(value.history ?? [])
      if (status) {
        // Una entrega tardía de un chunk anterior no revierte completed.
        let update = db.from('whatsapp_config').update(status).eq('account_id', config.account_id)
        if (status.history_sync_status === 'in_progress') update = update.or('history_sync_status.is.null,history_sync_status.not.in.(completed,declined,failed)')
        const { error } = await update
        if (error) throw error
      }
    }
  } catch (error) {
    if (field === 'history') await db.from('whatsapp_config').update({ history_sync_status: 'failed',
      last_signup_error: 'No se pudo guardar el historial de WhatsApp. Se puede reintentar sin duplicar mensajes.' }).eq('account_id', config.account_id)
    throw error
  }
}
