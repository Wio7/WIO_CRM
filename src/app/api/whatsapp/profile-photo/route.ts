// ============================================================
// /api/whatsapp/profile-photo — poner la foto de perfil del número de
// WhatsApp conectado a la cuenta.
//
//   POST { imagen: "data:image/jpeg;base64,..." } → { ok: true }
//
// La usa la app de Broker Home desde "Sobre mí": Julio trabaja solo y
// quiere que su foto sea también la del número. Es un cambio de toda la
// cuenta (lo ven todos los clientes que le escriben), así que sólo lo
// hacen el dueño o un administrador. Corre con la sesión de quien llama.
// ============================================================

import { NextResponse } from 'next/server'

import { getRequestAuth } from '@/lib/supabase/request-auth'
import { corsPreflight, withCors } from '@/lib/cors'
import { decrypt } from '@/lib/whatsapp/encryption'
import { FOTO_MAX_BYTES, imagenDeDataUrl, ponerFotoDePerfil } from '@/lib/whatsapp/profile-picture'

export function OPTIONS(request: Request) {
  return corsPreflight(request)
}

const responder = (request: Request, cuerpo: Record<string, unknown>, status = 200) =>
  withCors(request, NextResponse.json(cuerpo, { status }))

export async function POST(request: Request) {
  const { supabase, user } = await getRequestAuth(request)
  if (!user) return responder(request, { ok: false, error: 'Tu sesión venció. Vuelve a entrar.' }, 401)

  const { data: perfil } = await supabase
    .from('profiles')
    .select('account_id, account_role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!perfil?.account_id) return responder(request, { ok: false, error: 'Tu usuario no está en ninguna cuenta.' }, 403)
  if (!['owner', 'admin'].includes(String(perfil.account_role))) {
    return responder(request, { ok: false, error: 'Sólo el dueño o un administrador cambia la foto del WhatsApp.' }, 403)
  }

  let cuerpo: { imagen?: unknown }
  try {
    cuerpo = await request.json()
  } catch {
    return responder(request, { ok: false, error: 'Pedido inválido.' }, 400)
  }
  const imagen = imagenDeDataUrl(cuerpo.imagen)
  if (!imagen) return responder(request, { ok: false, error: 'La foto tiene que ser JPEG o PNG.' }, 400)
  if (imagen.bytes.byteLength > FOTO_MAX_BYTES) {
    return responder(request, { ok: false, error: 'La foto pesa más de 5 MB.' }, 400)
  }

  const appId = process.env.META_APP_ID
  if (!appId) {
    return responder(request, { ok: false, error: 'Falta META_APP_ID en el CRM para subir la foto a Meta.' }, 500)
  }

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', perfil.account_id)
    .maybeSingle()
  if (!config?.phone_number_id || !config?.access_token) {
    return responder(request, { ok: false, error: 'Esta cuenta no tiene un WhatsApp conectado.' }, 400)
  }

  try {
    await ponerFotoDePerfil({
      appId,
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      bytes: imagen.bytes,
      mimeType: imagen.mimeType,
    })
  } catch (e) {
    console.error('[whatsapp/profile-photo]', e instanceof Error ? e.message : e)
    return responder(request, { ok: false, error: `Meta no aceptó la foto: ${e instanceof Error ? e.message : 'error desconocido'}` }, 502)
  }
  return responder(request, { ok: true })
}
