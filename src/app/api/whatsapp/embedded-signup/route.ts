import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { requireRole, UnauthorizedError, ForbiddenError } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { embeddedSignupApi, SignupError } from '@/lib/whatsapp/embedded-signup'
import { parseSignupSession } from '@/lib/whatsapp/embedded-signup-session'

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const body = await request.json().catch(() => null)
    const session = parseSignupSession(body)
    if (!session || typeof body?.code !== 'string' || !body.code.trim() || body.code.length > 4096) {
      return NextResponse.json({ error: 'Datos de conexión inválidos o incompletos.' }, { status: 400 })
    }
    if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
      return NextResponse.json({ error: 'La conexión con Meta no está configurada en el servidor.' }, { status: 503 })
    }
    const admin = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const { data: claimed, error: claimError } = await admin.from('whatsapp_config')
      .select('account_id').eq('phone_number_id', session.phone_number_id).neq('account_id', accountId).maybeSingle()
    if (claimError) throw new Error()
    if (claimed) return NextResponse.json({ error: 'Este número de WhatsApp ya está conectado a otra cuenta.' }, { status: 409 })
    const { data: existing, error: readError } = await supabase.from('whatsapp_config')
      .select('phone_number_id, registered_at, contacts_sync_requested_at, history_sync_requested_at, history_sync_status, last_signup_error')
      .eq('account_id', accountId).maybeSingle()
    if (readError) throw new Error()
    const api = embeddedSignupApi()
    const { token, phone } = await api.connect(body.code, session, process.env.META_APP_ID, process.env.META_APP_SECRET)
    const coexistence = session.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'
    const sameNumber = existing?.phone_number_id === session.phone_number_id
    const now = new Date().toISOString()
    const registeredAt = coexistence ? now : sameNumber ? existing.registered_at : null
    const { error: saveError } = await supabase.from('whatsapp_config').upsert({
      account_id: accountId, user_id: userId, phone_number_id: session.phone_number_id,
      waba_id: session.waba_id, business_id: session.business_id ?? null,
      access_token: encrypt(token), connection_type: coexistence ? 'coexistence' : 'embedded',
      is_on_biz_app: phone.is_on_biz_app ?? null, platform_type: phone.platform_type ?? null,
      status: 'connected', connected_at: now, updated_at: now,
      registered_at: registeredAt, subscribed_apps_at: now, last_registration_error: null,
      // No sobrescribir reservas de sincronización de otra solicitud concurrente.
      ...(existing && !sameNumber ? {
        contacts_sync_requested_at: null, history_sync_requested_at: null,
        history_sync_status: null, last_signup_error: null,
      } : {}),
    }, { onConflict: 'account_id' })
    // La restricción UNIQUE de 013 también protege dos altas simultáneas.
    if (saveError?.code === '23505') return NextResponse.json({ error: 'El número ya está vinculado a otra cuenta.' }, { status: 409 })
    if (saveError) throw new Error()

    const warnings: string[] = []
    if (coexistence) {
      for (const [column, type] of [
        ['contacts_sync_requested_at', 'smb_app_state_sync'],
        ['history_sync_requested_at', 'history'],
      ] as const) {
        // Reservar antes de llamar a Meta evita repetir solicitudes al reconectar o en concurrencia.
        const { data: reserved, error: reserveError } = await supabase.from('whatsapp_config')
          .update({ [column]: new Date().toISOString(), ...(type === 'history' ? { history_sync_status: 'requested' } : {}) })
          .eq('account_id', accountId).eq('phone_number_id', session.phone_number_id).is(column, null).select('account_id')
        if (reserveError) { warnings.push(`No se pudo guardar la solicitud de ${type === 'history' ? 'historial' : 'contactos'}.`); continue }
        if (!reserved?.length) continue
        try { await api.sync(session.phone_number_id, token, type) }
        catch {
          warnings.push(`No se pudo solicitar la sincronización de ${type === 'history' ? 'historial' : 'contactos'}.`)
          if (type === 'history') await supabase.from('whatsapp_config').update({ history_sync_status: 'failed' })
            .eq('account_id', accountId).eq('phone_number_id', session.phone_number_id)
        }
      }
      if (warnings.length) {
        await supabase.from('whatsapp_config').update({ last_signup_error: warnings.join(' ') })
          .eq('account_id', accountId).eq('phone_number_id', session.phone_number_id)
      }
    }
    return NextResponse.json({ success: true, saved: true, registered: registeredAt != null,
      registration_skipped: !coexistence && registeredAt == null, phone_info: phone,
      last_signup_error: warnings.join(' ') || (sameNumber ? existing.last_signup_error : null) })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return NextResponse.json({ error: 'Necesitas una sesión de administrador de la cuenta.' }, { status: error.status })
    }
    if (error instanceof SignupError) return NextResponse.json({ error: error.message }, { status: 502 })
    // No registrar excepciones: pueden incluir credenciales del intercambio OAuth.
    return NextResponse.json({ error: 'No se pudo guardar la conexión de WhatsApp.' }, { status: 500 })
  }
}
