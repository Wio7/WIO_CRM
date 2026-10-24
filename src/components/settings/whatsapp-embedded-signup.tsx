'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { META_API_VERSION } from '@/lib/whatsapp/meta-api'
import { parseSignupMessage, signupConfigured, takeSignupPayload, type SignupSession } from '@/lib/whatsapp/embedded-signup-session'

type FacebookSDK = {
  init(options: object): void
  login(callback: (response: { authResponse?: { code?: string } }) => void, options: object): void
}
type SignupAttempt = { code?: string; session?: SignupSession; sent: boolean; timer?: ReturnType<typeof setTimeout> }
declare global { interface Window { FB?: FacebookSDK } }
let sdkPromise: Promise<FacebookSDK> | undefined
function loadSDK(appId: string) {
  if (!sdkPromise) sdkPromise = new Promise<FacebookSDK>((resolve, reject) => {
    const init = () => {
      if (!window.FB) { reject(new Error('SDK no disponible')); return }
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version: META_API_VERSION })
      resolve(window.FB)
    }
    if (window.FB) { init(); return }
    let script = document.getElementById('wio-facebook-sdk') as HTMLScriptElement | null
    if (!script) {
      script = document.createElement('script')
      script.id = 'wio-facebook-sdk'
      script.src = 'https://connect.facebook.net/en_US/sdk.js'
      script.async = true
      document.head.appendChild(script)
    }
    script.addEventListener('load', init, { once: true })
    script.addEventListener('error', () => reject(new Error('No se pudo cargar Meta')), { once: true })
  })
  return sdkPromise
}

export function WhatsAppEmbeddedSignup({ onConnected }: { onConnected?: () => void }) {
  const appId = process.env.NEXT_PUBLIC_META_APP_ID
  const configId = process.env.NEXT_PUBLIC_META_ES_CONFIG_ID
  const configured = signupConfigured(appId, configId)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const attempt = useRef<SignupAttempt | null>(null)
  const connectedCallback = useRef(onConnected)
  useEffect(() => { connectedCallback.current = onConnected }, [onConnected])

  const submit = useCallback(async () => {
    const current = attempt.current
    if (!current) return
    const payload = takeSignupPayload(current)
    if (!payload) return
    clearTimeout(current.timer)
    try {
      const response = await fetch('/api/whatsapp/embedded-signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const result = await response.json()
      if (attempt.current !== current) return
      if (!response.ok) throw new Error(result.error || 'No se pudo conectar WhatsApp.')
      const successMessage = `WhatsApp conectado.${result.registration_skipped ? ' Registro pendiente: configura el PIN en las opciones avanzadas.' : ''}${result.last_signup_error ? ` ${result.last_signup_error}` : ''}`
      setMessage(successMessage)
      toast.success(successMessage)
      connectedCallback.current?.()
    } catch (error) {
      if (attempt.current === current) setMessage(error instanceof Error ? error.message : 'No se pudo conectar WhatsApp.')
    } finally {
      if (attempt.current === current) { attempt.current = null; setBusy(false) }
    }
  }, [])

  useEffect(() => {
    let active = true
    if (configured) void loadSDK(appId!).then(() => { if (active) setReady(true) }).catch(() => {
      if (active) setMessage('No se pudo cargar Meta. Recarga la página para intentarlo de nuevo.')
    })
    const listener = (event: MessageEvent) => {
      const current = attempt.current
      if (!current || current.sent) return
      const parsed = parseSignupMessage(event.origin, event.data)
      if (!parsed) return
      if ('error' in parsed) {
        clearTimeout(current.timer); attempt.current = null; setBusy(false); setMessage(parsed.error)
      } else { current.session = parsed; void submit() }
    }
    window.addEventListener('message', listener)
    return () => {
      active = false
      window.removeEventListener('message', listener)
      clearTimeout(attempt.current?.timer)
      attempt.current = null
    }
  }, [appId, configured, submit])

  function launch() {
    if (!ready || !window.FB || attempt.current) return
    const current: SignupAttempt = { sent: false }
    attempt.current = current
    setBusy(true); setMessage('Completa la conexión en la ventana de Meta.')
    const expire = () => {
      if (attempt.current !== current || current.sent) return
      attempt.current = null; setBusy(false); setMessage('La conexión no se completó a tiempo. Inténtalo de nuevo.')
    }
    current.timer = setTimeout(expire, 5 * 60 * 1000)
    try {
      window.FB.login((response) => {
        if (attempt.current !== current || current.sent) return
        const code = response.authResponse?.code
        if (!code) {
          clearTimeout(current.timer); attempt.current = null; setBusy(false); setMessage('Conexión cancelada o no autorizada en Meta.'); return
        }
        current.code = code
        clearTimeout(current.timer)
        current.timer = setTimeout(expire, 25000)
        void submit()
      }, {
        config_id: configId, response_type: 'code', override_default_response_type: true,
        extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' },
      })
    } catch {
      clearTimeout(current.timer); attempt.current = null; setBusy(false); setMessage('No se pudo abrir Meta. Inténtalo de nuevo.')
    }
  }

  return <Card className="mb-6">
    <CardHeader>
      <CardTitle>Conectar mi WhatsApp</CardTitle>
      <CardDescription>Conecta WhatsApp Business con Meta sin copiar tokens y sigue usando tu celular.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="rounded-lg border border-border bg-muted p-4 text-sm text-muted-foreground">
        <p className="mb-2 font-medium text-foreground">Antes de conectar con coexistencia:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Se desvinculan WhatsApp Web y escritorio. WhatsApp para Windows no está soportado.</li>
          <li>Las listas de difusión quedan en modo de solo lectura.</li>
          <li>No se sincronizan grupos, mensajes temporales, mensajes de ver una vez ni ubicación en tiempo real.</li>
          <li>Los mensajes de bienvenida y ausencia y las respuestas rápidas pasan al CRM.</li>
        </ul>
      </div>
      <Button onClick={launch} disabled={!configured || !ready || busy}>{busy ? 'Conectando…' : 'Conectar mi WhatsApp'}</Button>
      {!configured && <p className="text-sm text-muted-foreground">La conexión con Meta todavía no está habilitada. Falta configurar el identificador público de la aplicación y la configuración de Embedded Signup.</p>}
      <p role="status" className="text-sm text-muted-foreground">{message}</p>
    </CardContent>
  </Card>
}
