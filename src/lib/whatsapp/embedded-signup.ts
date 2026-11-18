import { META_API_VERSION } from './meta-api'
import type { SignupSession } from './embedded-signup-session'

const BASE = `https://graph.facebook.com/${META_API_VERSION}`
export class SignupError extends Error {}
export function embeddedSignupApi(fetcher: typeof fetch = fetch) {
  async function request(step: string, path: string, token?: string, body?: object) {
    // Nunca propagar errores de transporte: podrían contener el token o la URL OAuth.
    // Del error de Meta solo se usan su código y su mensaje, que no incluyen credenciales.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any = null
    let ok = false
    try {
      const response = await fetcher(`${BASE}/${path}`, {
        method: body ? 'POST' : 'GET', cache: 'no-store', signal: AbortSignal.timeout(15000),
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      ok = response.ok
      result = await response.json().catch(() => null)
    } catch { /* se informa abajo */ }
    if (ok && result && !result.error && result.success !== false) return result
    const metaCode = typeof result?.error?.code === 'number' ? ` (código ${result.error.code})` : ''
    const metaMessage = typeof result?.error?.message === 'string' ? `: ${result.error.message.slice(0, 200)}` : ''
    throw new SignupError(`Meta no pudo ${step}${metaCode}${metaMessage}. Repite la conexión o revisa los permisos de la aplicación.`)
  }
  return {
    async connect(code: string, session: SignupSession, appId?: string, appSecret?: string) {
      if (!appId || !appSecret) throw new SignupError('La conexión con Meta no está configurada en el servidor.')
      const params = new URLSearchParams({ client_id: appId, client_secret: appSecret, code })
      const exchanged = await request('validar la autorización', `oauth/access_token?${params}`)
      if (typeof exchanged.access_token !== 'string' || !exchanged.access_token) throw new SignupError('Meta no devolvió un token válido.')
      const token = exchanged.access_token as string
      let wabaId = session.waba_id
      if (!wabaId) {
        // Sin waba_id en el evento: Meta lo lista en los permisos granulares del token.
        const debug = await request('identificar tu cuenta de WhatsApp', `debug_token?input_token=${encodeURIComponent(token)}`, `${appId}|${appSecret}`)
        const scopes = (debug?.data?.granular_scopes ?? []) as { scope?: string; target_ids?: string[] }[]
        wabaId = scopes.find(s => s.scope === 'whatsapp_business_management')?.target_ids?.[0]
        if (!wabaId) throw new SignupError('Meta no indicó la cuenta de WhatsApp conectada. Repite la conexión.')
      }
      await request('suscribir la aplicación a tu cuenta de WhatsApp', `${wabaId}/subscribed_apps`, token, {})
      let phoneId = session.phone_number_id
      if (!phoneId) {
        const list = await request('leer los números de tu cuenta', `${wabaId}/phone_numbers?fields=id`, token)
        const ids = ((list?.data ?? []) as { id?: string }[]).map(p => p.id).filter((id): id is string => typeof id === 'string')
        if (ids.length !== 1) throw new SignupError(ids.length ? 'La cuenta tiene varios números de WhatsApp. Conecta uno a la vez.' : 'La cuenta de WhatsApp no tiene números. Repite la conexión.')
        phoneId = ids[0]
      }
      // Ningún flujo llama /register: coexistencia ya está registrada; embedded no tiene PIN.
      const phone = await request('leer los datos del número', `${phoneId}?fields=is_on_biz_app,platform_type,display_phone_number,verified_name`, token)
      return { token, waba_id: wabaId, phone_number_id: phoneId, phone: phone as { is_on_biz_app?: boolean; platform_type?: string; display_phone_number?: string; verified_name?: string } }
    },
    async sync(phoneId: string, token: string, type: 'smb_app_state_sync' | 'history') {
      await request('pedir la sincronización', `${phoneId}/smb_app_data`, token, { messaging_product: 'whatsapp', sync_type: type })
    },
  }
}
