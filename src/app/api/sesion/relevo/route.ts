// ============================================================
// /api/sesion/relevo — sesión NUEVA e independiente para el mismo usuario.
//
//   POST (sin cuerpo) + Authorization: Bearer <access_token de Supabase>
//     → 200 { token_hash }   (la app destino lo canjea con verifyOtp)
//     → 401 { error: 'sesion' }   token ausente o inválido
//     → 403 { error: 'externo' }  usuario del área externa "promueve"
//
// La Golden App abre apps de área (otros dominios, mismo Supabase). Si
// compartieran la sesión, cuando una rota el refresh token la otra lo
// reutiliza, Supabase detecta la reutilización y revoca toda la sesión.
// Por eso cada app recibe su propia sesión: aquí se genera un enlace
// mágico con la clave de servicio (NO envía correo) y solo se devuelve su
// hash. Nunca se registra el token ni el hash.
// ============================================================

import { NextResponse } from 'next/server'

import { esAreaExterna } from '@/lib/apps/acceso'
import { corsPreflight, withCors } from '@/lib/cors'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getRequestAuth } from '@/lib/supabase/request-auth'

export function OPTIONS(request: Request) {
  return corsPreflight(request)
}

const responder = (request: Request, cuerpo: Record<string, unknown>, status = 200) =>
  withCors(request, NextResponse.json(cuerpo, { status }))

export async function POST(request: Request) {
  // Solo Bearer: nada de cookies para esta ruta.
  if (!request.headers.get('authorization')?.startsWith('Bearer ')) {
    return responder(request, { error: 'sesion' }, 401)
  }
  const { user } = await getRequestAuth(request)
  if (!user || !user.email) return responder(request, { error: 'sesion' }, 401)

  const limite = checkRateLimit(`sesion-relevo:${user.id}`, RATE_LIMITS.sesionRelevo)
  if (!limite.success) return withCors(request, rateLimitResponse(limite))

  const admin = supabaseAdmin()
  const { data: perfil } = await admin
    .from('profiles')
    .select('area')
    .eq('user_id', user.id)
    .maybeSingle()
  if (esAreaExterna((perfil?.area as string | null | undefined) ?? null)) {
    return responder(request, { error: 'externo' }, 403)
  }

  const { data, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: user.email,
  })
  const hash = data?.properties?.hashed_token
  if (error || !hash) {
    return responder(request, { error: 'relevo' }, 502)
  }
  return responder(request, { token_hash: hash })
}
