import { describe, expect, it, vi } from 'vitest'
import { embeddedSignupApi } from './embedded-signup'
import { FINISH_EVENTS, parseSignupMessage, signupConfigured, takeSignupPayload, type SignupSession } from './embedded-signup-session'

const session = { event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' as const, phone_number_id: '123', waba_id: '456', business_id: '789' }
describe('sesión de Embedded Signup', () => {
  it.each(['code', 'session'])('envía una vez cuando llega %s primero', first => {
    const attempt: { code?: string; session?: SignupSession; sent: boolean } = { sent: false }
    if (first === 'code') attempt.code = 'code'
    else attempt.session = session
    expect(takeSignupPayload(attempt)).toBeNull()
    attempt.code = 'code'; attempt.session = session
    expect(takeSignupPayload(attempt)).toEqual({ code: 'code', ...session })
    expect(takeSignupPayload(attempt)).toBeNull()
  })
  const raw = (event = 'FINISH') => JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event, data: session })
  it.each(['https://facebook.com', 'https://www.facebook.com'])('acepta %s', origin => {
    for (const event of FINISH_EVENTS) expect(parseSignupMessage(origin, raw(event))).toEqual({ ...session, event })
  })
  it.each(['https://evilfacebook.com', 'https://facebook.com.evil.test', 'http://facebook.com', 'null', 'https://evil.test'])('rechaza %s', origin => {
    expect(parseSignupMessage(origin, raw())).toBeNull()
  })
  it('ignora JSON roto y otros mensajes; informa cancelación y número ausente', () => {
    expect(parseSignupMessage('https://facebook.com', '{')).toBeNull()
    expect(parseSignupMessage('https://facebook.com', JSON.stringify({ type: 'OTHER' }))).toBeNull()
    expect(parseSignupMessage('https://facebook.com', JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: { current_step: 'PHONE' } }))).toEqual({ error: 'Conexión cancelada: PHONE' })
    expect(parseSignupMessage('https://facebook.com', JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_ONLY_WABA', data: { waba_id: '456' } }))).toHaveProperty('error')
  })
  it('deshabilita la configuración pública incompleta', () => {
    expect(signupConfigured(undefined, '123')).toBe(false)
    expect(signupConfigured('123', '')).toBe(false)
    expect(signupConfigured('123', '456')).toBe(true)
  })
})
describe('Graph Embedded Signup', () => {
  it('canjea, suscribe, lee el número y sincroniza en orden, sin register', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: 'secret-token' }))
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(Response.json({ is_on_biz_app: true, platform_type: 'CLOUD_API' }))
      .mockImplementation(async () => Response.json({ success: true }))
    const api = embeddedSignupApi(fetcher)
    const result = await api.connect('code&123', session, 'app', 'secret')
    await api.sync('123', result.token, 'smb_app_state_sync')
    await api.sync('123', result.token, 'history')
    const calls = fetcher.mock.calls
    expect(new URL(String(calls[0][0])).searchParams.get('code')).toBe('code&123')
    expect(calls[1][0]).toContain('/456/subscribed_apps')
    expect(calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer secret-token' })
    expect(calls[2][0]).toContain('fields=is_on_biz_app,platform_type,display_phone_number,verified_name')
    expect(calls[3][1]?.body).toContain('smb_app_state_sync')
    expect(calls[4][1]?.body).toContain('history')
    expect(calls.some(([url]) => String(url).includes('/register'))).toBe(false)
  })
  it('no hace llamadas sin variables del servidor y no filtra errores sensibles', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret-token'))
    const api = embeddedSignupApi(fetcher)
    await expect(api.connect('code', session, undefined, 'secret')).rejects.toThrow('no está configurada')
    expect(fetcher).not.toHaveBeenCalled()
    await expect(api.connect('code', session, 'app', 'secret')).rejects.not.toThrow('secret-token')
  })
})
