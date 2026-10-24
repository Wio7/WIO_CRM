import { describe, expect, it, vi } from 'vitest'
import { classifyDirection, computeSyncStatus, dedupeMessages, historyContent, isCoexistenceField, mapStateSync, mapSyncMessage, type SyncMessage, type SyncValue } from './coexistence-sync'
import { processCoexistenceChange } from './coexistence-sync-handler'
import type { SupabaseClient } from '@supabase/supabase-js'

const message: SyncMessage = { from: '51911111111', to: '51922222222', id: 'wamid.1', timestamp: '1700000000', type: 'text', text: { body: 'Desde el teléfono' } }
const metadata = { display_phone_number: '+51 911 111 111', phone_number_id: 'phone-id' }
const echo: SyncValue = { messaging_product: 'whatsapp', metadata, message_echoes: [message, message] }
const history: SyncValue = { messaging_product: 'whatsapp', metadata, history: [{
  metadata: { phase: 0, chunk_order: 1, progress: 20 },
  threads: [{ id: '51922222222', messages: [message, { ...message, id: 'wamid.2', from: '51922222222', to: undefined, history_context: { status: 'read' } }] }],
}] }

describe('mapeo puro de coexistencia', () => {
  it('eco saliente, procedencia, columnas y dedupe por Meta id', () => {
    const unique = dedupeMessages(echo.message_echoes!)
    expect(unique).toHaveLength(1)
    expect(dedupeMessages(unique, new Set(['wamid.1']))).toEqual([])
    expect(mapSyncMessage(unique[0], 'conv', metadata.display_phone_number, 'phone_app')).toMatchObject({
      conversation_id: 'conv', sender_type: 'agent', sender_id: null, status: 'sent', source: 'phone_app',
      message_id: 'wamid.1', content_text: 'Desde el teléfono', created_at: '2023-11-14T22:13:20.000Z',
    })
  })
  it('dirección del historial por to o número de negocio normalizado', () => {
    const messages = history.history![0].threads![0].messages
    expect(messages.map(m => classifyDirection(m, metadata.display_phone_number))).toEqual(['agent', 'customer'])
    expect(classifyDirection({ ...message, to: undefined }, metadata.display_phone_number)).toBe('agent')
    expect(mapSyncMessage(messages[1], 'conv', metadata.display_phone_number, 'phone_history')).toMatchObject({ sender_type: 'customer', status: 'read', source: 'phone_history' })
  })
  it('placeholder multimedia, sin consultas externas', () => {
    const placeholder = { ...message, type: 'media_placeholder', text: undefined }
    expect(mapSyncMessage(placeholder, 'conv', '', 'phone_history')).toMatchObject({ content_type: 'text', content_text: '[Archivo multimedia del historial]', media_url: null })
    expect(historyContent({ ...message, type: 'image', text: undefined, image: { id: 'media', mime_type: 'image/jpeg', caption: 'Foto' } })).toMatchObject({ contentText: 'Foto', mediaUrl: '/api/whatsapp/media/media' })
  })
  it('estados por progreso y errores con la estructura de Meta', () => {
    expect(computeSyncStatus(history.history!)).toMatchObject({ history_sync_status: 'in_progress' })
    expect(computeSyncStatus([{ metadata: { phase: 2, chunk_order: 4, progress: 100 } }])).toMatchObject({ history_sync_status: 'completed' })
    const declined: SyncValue = { messaging_product: 'whatsapp', metadata, history: [{ errors: [{ code: 2593109, title: 'Declined', message: 'Declined', error_data: { details: 'User declined history' } }] }] }
    expect(computeSyncStatus(declined.history!)).toMatchObject({ history_sync_status: 'declined', last_signup_error: expect.stringContaining('rechazó') })
    expect(computeSyncStatus([{ errors: [{ code: 123 }] }])).toMatchObject({ history_sync_status: 'failed' })
  })
  it('contactos add normalizados; remove y otros tipos ignorados', () => {
    const value: SyncValue = { messaging_product: 'whatsapp', metadata, state_sync: [
      { type: 'contact', contact: { full_name: 'Ana Pérez', first_name: 'Ana', phone_number: '+51 922 222 222' }, action: 'add', metadata: { timestamp: '1700000000' } },
      { type: 'contact', contact: { phone_number: '51933333333' }, action: 'remove', metadata: { timestamp: '1700000001' } },
    ] }
    expect(mapStateSync(value.state_sync!)).toEqual([{ phone: '51922222222', name: 'Ana Pérez' }])
  })
  it('timestamp inválido no se convierte en actividad actual', () => {
    expect(mapSyncMessage({ ...message, timestamp: 'bad' }, 'conv', '', 'phone_history')).toBeNull()
  })
  it('campo desconocido ignorado sin leer ni escribir', async () => {
    const from = vi.fn()
    expect(isCoexistenceField('future_field')).toBe(false)
    await processCoexistenceChange({ from } as unknown as SupabaseClient, 'future_field', echo, { findContact: vi.fn(), findConversation: vi.fn() })
    expect(from).not.toHaveBeenCalled()
  })
  it('historial grande: una resolución por hilo, lotes de 200, tenant del config', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null })
    const update = vi.fn()
    const query = { select: () => query, eq: vi.fn().mockResolvedValue({ data: [{ account_id: 'account', user_id: 'owner' }], error: null }) }
    const statusQuery = { eq: () => statusQuery, or: vi.fn().mockResolvedValue({ error: null }) }
    update.mockReturnValue(statusQuery)
    const db = { from: () => ({ ...query, update }), rpc } as unknown as SupabaseClient
    const deps = { findContact: vi.fn().mockResolvedValue({ contact: { id: 'contact' } }), findConversation: vi.fn().mockResolvedValue({ conversation: { id: 'conv' } }) }
    await processCoexistenceChange(db, 'history', { ...history, history: [{ ...history.history![0], threads: [{ id: '51922222222', messages: Array.from({ length: 405 }, (_, i) => ({ ...message, id: `wamid.${i}` })) }] }] }, deps)
    expect(query.eq).toHaveBeenCalledWith('phone_number_id', 'phone-id')
    expect(deps.findContact).toHaveBeenCalledExactlyOnceWith('account', 'owner', '51922222222')
    expect(deps.findConversation).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls.map(call => call[1].p_rows.length)).toEqual([200, 200, 5])
    expect(rpc.mock.calls.every(call => call[1].p_account === 'account')).toBe(true)
    expect(update).toHaveBeenCalledWith({ history_sync_status: 'in_progress', last_signup_error: null })
  })
})
