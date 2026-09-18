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

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { corsPreflight, withCors } from "@/lib/cors";
import { bearerToken } from "@/lib/client-portal/http";
import { resolveClientSession } from "@/lib/client-portal/sessions";

/** Un minuto y medio de voz sobra para un mensaje y no cuesta casi nada. */
const MAXIMO_BYTES = 8 * 1024 * 1024;

const WHISPER = "https://api.openai.com/v1/audio/transcriptions";

/**
 * Lo que Whisper se inventa cuando el audio no tiene voz.
 *
 * Con silencio o ruido no devuelve vacío: devuelve una de las frases que
 * aprendió de tanto video subtitulado. Comprobado contra producción el
 * 2026-09-17 con un tono puro — contestó "Subtítulos realizados por la
 * comunidad de Amara.org". Si eso llegara al cuadro de texto del cliente,
 * pensaría que la app se volvió loca.
 *
 * Se comparan sin tildes ni mayúsculas, y por "contiene": las variantes
 * son muchas y todas llevan una de estas marcas dentro.
 */
const INVENTOS = [
  "amara.org",
  "subtitulos realizados por",
  "subtitulado por la comunidad",
  "subtitulos por",
  "gracias por ver el video",
  "www.youtube.com",
];

// El rango del replace son los signos diacríticos que deja `NFD` al
// separar las tildes de su letra. No se ven en el editor: si alguien toca
// esta línea, que sea copiándola entera.
const sinTildes = (t: string) =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

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

  const envio = new FormData();
  envio.append("file", audio, audio.name || "voz.webm");
  envio.append("model", "whisper-1");
  // Español fijo: el cliente es peruano y decírselo mejora bastante los
  // nombres propios y los números, que es justo lo que va a dictar
  // ("mi cuota de mayo", "operación 884512").
  envio.append("language", "es");

  let res: Response;
  try {
    res = await fetch(WHISPER, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: envio,
    });
  } catch (err) {
    console.error("[client-portal] whisper unreachable:", err);
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "server_error" }, { status: 502 }),
    );
  }

  if (!res.ok) {
    console.error("[client-portal] whisper said", res.status, await res.text().catch(() => ""));
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "server_error" }, { status: 502 }),
    );
  }

  const datos = (await res.json().catch(() => ({}))) as { text?: string };
  const texto = (datos.text ?? "").trim();
  const limpio = INVENTOS.some((f) => sinTildes(texto).includes(f)) ? "" : texto;

  // Texto vacío es una respuesta legítima: "no se te oyó". La app lo dice
  // así en vez de pegar un invento en el mensaje del cliente.
  return withCors(request, NextResponse.json({ ok: true, texto: limpio }));
}
