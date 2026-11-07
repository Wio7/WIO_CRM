import { afterEach, describe, expect, it, vi } from 'vitest'
import { corsHeaders, origenPermitido } from './cors'

afterEach(() => vi.unstubAllEnvs())

describe('origenPermitido', () => {
  it('deja entrar a cualquier app en un subdominio de wiocompany.com', () => {
    expect(origenPermitido('https://broker.wiocompany.com')).toBe(true)
    expect(origenPermitido('https://golden.wiocompany.com')).toBe(true)
  })

  it('no deja entrar a dominios que solo se parecen', () => {
    expect(origenPermitido('https://wiocompany.com.malo.com')).toBe(false)
    expect(origenPermitido('https://malowiocompany.com')).toBe(false)
    expect(origenPermitido('http://broker.wiocompany.com')).toBe(false)
    expect(origenPermitido('https://broker.wiocompany.com:8443')).toBe(false)
    expect(origenPermitido('https://broker-home.vercel.app')).toBe(false)
    expect(origenPermitido(null)).toBe(false)
  })

  it('sigue leyendo la lista exacta de APP_CORS_ORIGINS', () => {
    vi.stubEnv('APP_CORS_ORIGINS', 'https://golden-habitat-studios.vercel.app, https://app.cliente.pe/')
    expect(origenPermitido('https://golden-habitat-studios.vercel.app')).toBe(true)
    expect(origenPermitido('https://app.cliente.pe')).toBe(true)
  })
})

describe('corsHeaders', () => {
  it('responde con el mismo origen permitido', () => {
    const req = new Request('https://wio-crm.vercel.app/api/whatsapp/send', {
      headers: { origin: 'https://broker.wiocompany.com' },
    })
    expect(corsHeaders(req)['Access-Control-Allow-Origin']).toBe('https://broker.wiocompany.com')
  })

  it('sin origen permitido no manda encabezados', () => {
    const req = new Request('https://wio-crm.vercel.app/api/whatsapp/send', {
      headers: { origin: 'https://otra-web.com' },
    })
    expect(corsHeaders(req)).toEqual({})
  })
})
