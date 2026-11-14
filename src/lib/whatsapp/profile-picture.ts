// ============================================================
// Foto de perfil del número de WhatsApp (Cloud API).
//
// Meta no acepta la imagen directa: primero se sube con la Resumable
// Upload API (uploadResumableMedia, que pide META_APP_ID) y el "handle"
// que devuelve se manda en
//   POST /{phone-number-id}/whatsapp_business_profile
//   { messaging_product: "whatsapp", profile_picture_handle }
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/business-profiles/
// ============================================================

import { META_API_VERSION, MetaApiError, uploadResumableMedia } from './meta-api'

export const FOTO_MAX_BYTES = 5 * 1024 * 1024

/** "data:image/jpeg;base64,..." → bytes y tipo. null si no es JPEG/PNG en base64. */
export function imagenDeDataUrl(dataUrl: unknown): { bytes: Uint8Array; mimeType: string } | null {
  if (typeof dataUrl !== 'string') return null
  const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim())
  if (!m) return null
  const bytes = new Uint8Array(Buffer.from(m[2], 'base64'))
  if (bytes.byteLength === 0) return null
  return { bytes, mimeType: m[1] }
}

export interface PonerFotoArgs {
  appId: string
  phoneNumberId: string
  accessToken: string
  bytes: Uint8Array
  mimeType: string
}

/** Sube la imagen y la pone como foto de perfil del número. */
export async function ponerFotoDePerfil(args: PonerFotoArgs): Promise<void> {
  const { appId, phoneNumberId, accessToken, bytes, mimeType } = args
  const { handle } = await uploadResumableMedia({
    appId,
    accessToken,
    fileName: mimeType === 'image/png' ? 'perfil.png' : 'perfil.jpg',
    mimeType,
    bytes,
  })
  const res = await fetch(
    `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}/whatsapp_business_profile`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', profile_picture_handle: handle }),
    },
  )
  if (!res.ok) {
    let mensaje = `Meta rechazó la foto de perfil (${res.status}).`
    let codigo: number | undefined
    try {
      const data = (await res.json()) as { error?: { message?: string; code?: number } }
      if (data.error?.message) mensaje = data.error.message
      codigo = data.error?.code
    } catch { /* cuerpo no JSON */ }
    throw new MetaApiError(mensaje, codigo)
  }
}
