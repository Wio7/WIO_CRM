// ============================================================
// /api/assistant/voice — hablarle al Asistente Golden
//
//   POST Bearer <sesión del asesor>  multipart/form-data { audio }
//     → { ok: true, texto } | { ok: false, reason }
//
// Igual que /api/client/voice pero para el equipo: entra con la sesión
// del asesor (cookies o Bearer, como /api/assistant) en vez de la del
// cliente. Sólo transcribe y devuelve; el envío al asistente lo hace la
// Golden App con ese texto.
// ============================================================

import { NextResponse } from "next/server";

import { corsPreflight, withCors } from "@/lib/cors";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { getRequestAuth } from "@/lib/supabase/request-auth";
import { MAXIMO_BYTES, transcribirAudio } from "@/lib/whisper";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const responder = (request: Request, cuerpo: object, status = 200) =>
  withCors(request, NextResponse.json(cuerpo, { status }));

export async function POST(request: Request) {
  const { supabase, user } = await getRequestAuth(request);
  if (!user) return responder(request, { ok: false, reason: "signed_out" }, 401);

  // Igual que el asistente: sólo quien pertenece a una cuenta y no es "solo lectura".
  const { data: perfil } = await supabase
    .from("profiles")
    .select("account_id, account_role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!perfil?.account_id || perfil.account_role === "viewer") {
    return responder(request, { ok: false, reason: "forbidden" }, 403);
  }

  // Cada transcripción cuesta; un asesor no necesita más de una por segundo.
  const limite = checkRateLimit(`assistant-voice:${user.id}`, { limit: 30, windowMs: 60_000 });
  if (!limite.success) return withCors(request, rateLimitResponse(limite));

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return responder(request, { ok: false, reason: "sin_config" }, 503);

  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof File) || audio.size === 0) {
    return responder(request, { ok: false, reason: "invalid_input" }, 400);
  }
  if (audio.size > MAXIMO_BYTES) {
    return responder(request, { ok: false, reason: "muy_largo" }, 413);
  }

  const r = await transcribirAudio(audio, apiKey);
  if (!r.ok) return responder(request, { ok: false, reason: "server_error" }, 502);
  return responder(request, { ok: true, texto: r.texto });
}
