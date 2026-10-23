export const FINISH_EVENTS = ['FINISH', 'FINISH_ONLY_WABA', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'] as const
export type FinishEvent = typeof FINISH_EVENTS[number]
export interface SignupSession {
  event: FinishEvent
  phone_number_id: string
  waba_id: string
  business_id?: string
}
export function takeSignupPayload(attempt: { code?: string; session?: SignupSession; sent: boolean }) {
  if (!attempt.code || !attempt.session || attempt.sent) return null
  attempt.sent = true
  return { code: attempt.code, ...attempt.session }
}
const isId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,32}$/.test(v)
export function parseSignupSession(value: unknown): SignupSession | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!FINISH_EVENTS.includes(v.event as FinishEvent) || !isId(v.phone_number_id) || !isId(v.waba_id)) return null
  if (v.business_id != null && !isId(v.business_id)) return null
  return { event: v.event as FinishEvent, phone_number_id: v.phone_number_id, waba_id: v.waba_id,
    ...(isId(v.business_id) ? { business_id: v.business_id } : {}) }
}
export function signupConfigured(appId?: string, configId?: string) {
  return Boolean(appId?.trim() && configId?.trim())
}
export function parseSignupMessage(origin: string, raw: unknown): SignupSession | { error: string } | null {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'https:' || !(url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com'))) return null
    if (typeof raw !== 'string') return null
    const message = JSON.parse(raw)
    if (message?.type !== 'WA_EMBEDDED_SIGNUP') return null
    if (message.event === 'CANCEL') return { error: `Conexión cancelada: ${message.data?.current_step || message.data?.error_message || 'no se completó el proceso'}` }
    if (!FINISH_EVENTS.includes(message.event)) return null
    return parseSignupSession({ ...message.data, event: message.event }) ?? { error: 'Meta no devolvió un número de WhatsApp. Repite la conexión y selecciona un número.' }
  } catch { return null }
}
