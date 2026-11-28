// ============================================================
// /api/golden/aviso-prueba — botón "Probar aviso" de las apps de área.
//
//   POST Bearer <sesión del CRM>   (cuerpo ignorado)
//     → { ok: true, enviados } | { ok: false, reason }
//
// Manda una notificación SOLO a los celulares de quien la pide, para
// comprobar que suena con la pantalla bloqueada. Nada del cuerpo llega al
// aviso: título, texto y URL son fijos ("/" = el inicio de la app que lo
// recibe; cada service worker lo resuelve contra su propio origen).
// ============================================================

import { NextResponse } from "next/server";

import { corsPreflight, withCors } from "@/lib/cors";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { notifyUsers } from "@/lib/push/send";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { getRequestAuth } from "@/lib/supabase/request-auth";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const responder = (request: Request, cuerpo: object, status = 200) =>
  withCors(request, NextResponse.json(cuerpo, { status }));

export async function POST(request: Request) {
  const { user } = await getRequestAuth(request);
  if (!user) return responder(request, { ok: false, reason: "signed_out" }, 401);

  const limite = checkRateLimit(`golden-aviso-prueba:${user.id}`, { limit: 3, windowMs: 60_000 });
  if (!limite.success) return withCors(request, rateLimitResponse(limite));

  const enviados = await notifyUsers(supabaseAdmin(), {
    userIds: [user.id],
    title: "Prueba de aviso",
    body: "Si escuchaste esto con el celular bloqueado, los avisos funcionan.",
    url: "/",
    tag: "prueba-aviso",
  });
  return responder(request, { ok: true, enviados });
}
