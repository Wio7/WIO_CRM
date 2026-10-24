import { normalizePhone } from './phone-utils'
import type { WhatsAppMessage } from './message-content'

export type SyncMessage = WhatsAppMessage & { to?: string; history_context?: { status?: string } }
export interface HistoryChunk {
  metadata?: { phase: number; chunk_order: number; progress: number }
  threads?: { id: string; messages: SyncMessage[] }[]
  errors?: { code: number; title?: string; message?: string; error_data?: { details?: string } }[]
}
export interface StateChange {
  type: string
  contact?: { full_name?: string; first_name?: string; phone_number: string }
  action: string
  metadata?: { timestamp: string }
}
export interface SyncValue {
  messaging_product?: string
  metadata?: { phone_number_id: string; display_phone_number: string }
  message_echoes?: SyncMessage[]
  history?: HistoryChunk[]
  state_sync?: StateChange[]
}
export function isCoexistenceField(field: string) {
  return ['smb_message_echoes', 'history', 'smb_app_state_sync'].includes(field)
}
export function classifyDirection(message: SyncMessage, businessPhone: string) {
  return message.to || (normalizePhone(businessPhone) && normalizePhone(message.from) === normalizePhone(businessPhone))
    ? 'agent' as const : 'customer' as const
}

const allowedTypes = new Set(['text', 'image', 'video', 'audio', 'document', 'location', 'template', 'interactive'])
export interface ParsedSyncContent { contentText: string | null; mediaUrl: string | null; interactiveReplyId?: string | null }

// El historial no consulta Meta por cada archivo: puede traer miles de mensajes.
export function historyContent(message: SyncMessage): ParsedSyncContent {
  if (message.type === 'media_placeholder') return { contentText: '[Archivo multimedia del historial]', mediaUrl: null }
  const media = message.image ?? message.video ?? message.document ?? message.audio ?? message.sticker
  const reply = message.interactive?.button_reply ?? message.interactive?.list_reply
  const location = message.location
  return {
    contentText: message.text?.body ?? message.image?.caption ?? message.video?.caption
      ?? message.document?.caption ?? message.document?.filename
      ?? reply?.title ?? (location ? [location.name, location.address, `${location.latitude},${location.longitude}`].filter(Boolean).join(' - ') : null)
      ?? `[${message.type}]`,
    mediaUrl: media?.id ? `/api/whatsapp/media/${media.id}` : null,
    interactiveReplyId: reply?.id ?? null,
  }
}
export function mapSyncMessage(message: SyncMessage, conversationId: string, businessPhone: string,
  source: 'phone_app' | 'phone_history', parsed = historyContent(message)) {
  const timestamp = Number(message.timestamp) * 1000
  if (!message.id || !message.timestamp || !Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) return null
  const sender = source === 'phone_app' ? 'agent' : classifyDirection(message, businessPhone)
  const historyStatus = message.history_context?.status
  return {
    conversation_id: conversationId,
    sender_type: sender,
    sender_id: null, // No atribuir el teléfono a un asesor del CRM.
    content_type: allowedTypes.has(message.type) ? message.type : message.type === 'sticker' ? 'image' : 'text',
    content_text: parsed.contentText,
    media_url: parsed.mediaUrl,
    interactive_reply_id: parsed.interactiveReplyId ?? null,
    message_id: message.id,
    status: source === 'phone_app' ? 'sent' : historyStatus && ['sent', 'delivered', 'read', 'failed'].includes(historyStatus)
      ? historyStatus : sender === 'agent' ? 'sent' : 'delivered',
    created_at: new Date(timestamp).toISOString(),
    source,
  }
}
export function dedupeMessages<T extends { id: string }>(messages: T[], existingIds: ReadonlySet<string> = new Set()): T[] {
  const seen = new Set(existingIds)
  return messages.filter(message => {
    if (!message.id || seen.has(message.id)) return false
    seen.add(message.id)
    return true
  })
}
export function mapStateSync(changes: StateChange[]) {
  return changes.flatMap(change => {
    if (change.type !== 'contact' || change.action !== 'add' || !change.contact) return []
    const phone = normalizePhone(change.contact.phone_number)
    return phone ? [{ phone, name: change.contact.full_name?.trim() || change.contact.first_name?.trim() || null }] : []
  })
}
export function computeSyncStatus(chunks: HistoryChunk[]) {
  const errors = chunks.flatMap(chunk => chunk.errors ?? [])
  if (errors.length) {
    const declined = errors.some(error => error.code === 2593109)
    return { history_sync_status: declined ? 'declined' : 'failed', last_signup_error: declined
      ? 'El usuario rechazó compartir el historial de WhatsApp.' : `No se pudo sincronizar el historial de WhatsApp (código ${errors[0].code}).` }
  }
  const progress = chunks.flatMap(chunk => chunk.metadata ? [chunk.metadata.progress] : [])
  if (!progress.length) return null
  return { history_sync_status: Math.max(...progress) >= 100 ? 'completed' : 'in_progress', last_signup_error: null }
}
