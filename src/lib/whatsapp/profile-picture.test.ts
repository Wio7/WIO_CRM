import { afterEach, describe, expect, it, vi } from 'vitest'
import { imagenDeDataUrl, ponerFotoDePerfil } from './profile-picture'

const respuesta = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as Response

describe('imagenDeDataUrl', () => {
  it('lee un JPEG en base64', () => {
    const r = imagenDeDataUrl('data:image/jpeg;base64,AQID')
    expect(r?.mimeType).toBe('image/jpeg')
    expect(Array.from(r!.bytes)).toEqual([1, 2, 3])
  })
  it('rechaza otros tipos o texto suelto', () => {
    expect(imagenDeDataUrl('data:image/gif;base64,AQID')).toBeNull()
    expect(imagenDeDataUrl('hola')).toBeNull()
    expect(imagenDeDataUrl(42)).toBeNull()
  })
})

describe('ponerFotoDePerfil', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sube la imagen y manda el handle al perfil del número', async () => {
    const llamadas: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      llamadas.push({ url, init })
      if (url.includes('/uploads?')) return respuesta({ id: 'upload:S1' })
      if (url.includes('upload:S1')) return respuesta({ h: '4:HANDLE' })
      return respuesta({ success: true })
    }))

    await ponerFotoDePerfil({
      appId: 'app-1', phoneNumberId: 'PN1', accessToken: 'tok',
      bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg',
    })

    expect(llamadas).toHaveLength(3)
    expect(llamadas[2].url).toMatch(/\/PN1\/whatsapp_business_profile$/)
    expect(JSON.parse(String(llamadas[2].init?.body))).toEqual({
      messaging_product: 'whatsapp', profile_picture_handle: '4:HANDLE',
    })
    expect((llamadas[2].init?.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('pasa el mensaje de Meta si rechaza la foto', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/uploads?')) return respuesta({ id: 'upload:S1' })
      if (url.includes('upload:S1')) return respuesta({ h: '4:H' })
      return respuesta({ error: { message: 'Invalid image', code: 100 } }, false, 400)
    }))
    await expect(ponerFotoDePerfil({
      appId: 'a', phoneNumberId: 'p', accessToken: 't', bytes: new Uint8Array([1]), mimeType: 'image/png',
    })).rejects.toThrow('Invalid image')
  })
})
