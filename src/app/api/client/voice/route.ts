// ============================================================
// /api/client/voice — hablarle a la app en vez de escribirle
//
//   POST Bearer <token>  multipart/form-data { audio }
//     → { ok: true, texto } | { ok: false, reason }
//
// El cliente aprieta el micrófono, habla, y lo que dijo aparece escrito
// en su cuadro de texto para que lo revise antes de mandarlo. Mucha
// gente que compra un lote escribe con dificultad y habla sin ninguna:
// dictar no es un adorno, es la diferencia entre que escriba o que no.
//
// La transcripción la hace Whisper (OpenAI). La llave vive SOLO aquí:
// una app en el navegador no puede tener una llave de API, así que el
// audio pasa por el CRM y la llave nunca sale del servidor.
//
// Esto transcribe y devuelve, nada más. No manda el mensaje: el cliente
// lee lo que entendió el dictado y decide. Un mensaje enviado solo, con
// una palabra mal oída, es peor que no tener dictado.
// ============================================================

import { NextResponse } from "next/server";

import { transcribirAudio, MAXIMO_BYTES } from "@/lib/whisper";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { corsPreflight, withCors } from "@/lib/cors";
import { bearerToken } from "@/lib/client-portal/http";
import { resolveClientSession } from "@/lib/client-portal/sessions";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

export async function POST(request: Request) {
  const db = supabaseAdmin();
  const session = await resolveClientSession(db, bearerToken(request)).catch(() => null);
  if (!session) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "signed_out" }, { status: 401 }),
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Falta la llave en el entorno: se dice tal cual para que la app
    // esconda el micrófono en vez de ofrecer algo que no funciona.
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "sin_config" }, { status: 503 }),
    );
  }

  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof File) || audio.size === 0) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "invalid_input" }, { status: 400 }),
    );
  }
  if (audio.size > MAXIMO_BYTES) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "muy_largo" }, { status: 413 }),
    );
  }

  const r = await transcribirAudio(audio, apiKey);
  if (!r.ok) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "server_error" }, { status: 502 }),
    );
  }
  // Texto vacío es una respuesta legítima: "no se te oyó". La app lo dice
  // así en vez de pegar un invento en el mensaje del cliente.
  return withCors(request, NextResponse.json({ ok: true, texto: r.texto }));
}
