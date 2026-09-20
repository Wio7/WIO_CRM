// ============================================================
// Transcribir audios (Whisper).
//
// Un cliente manda una nota de voz tan tranquilo como escribe, y hasta
// ahora la IA no se enteraba: al webhook sólo le llegaba "🎤 Audio" y se
// quedaba callada. Aquí se baja el audio de Meta, se transcribe, y el
// texto entra en el mensaje — así lo lee la IA y también el asesor, que
// puede responder sin ponerse los audífonos.
//
// Usa la misma llave del servidor que el dictado del cliente
// (OPENAI_API_KEY). Sin llave, no transcribe y no pasa nada más.
// ============================================================

import { downloadMedia, getMediaUrl } from "@/lib/whatsapp/meta-api";

const WHISPER = "https://api.openai.com/v1/audio/transcriptions";
const MAXIMO_BYTES = 24 * 1024 * 1024;

const sinTildes = (t: string) =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Whisper, cuando no hay voz, devuelve muletillas de subtítulos que
 * aprendió de los vídeos con los que lo entrenaron. Si la transcripción
 * es una de ésas, no se dijo nada.
 */
const INVENTOS = [
  "subtitulos realizados por la comunidad de amara.org",
  "subtitulado por la comunidad de amara.org",
  "subtitulos por la comunidad de amara.org",
  "amara.org",
  "gracias por ver el video",
  "mas videos en",
];

/** Transcribe un audio ya descargado. Cadena vacía = no se entendió nada. */
export async function transcribir(
  audio: Buffer,
  nombre = "audio.ogg",
  tipo = "audio/ogg",
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || !audio.length || audio.length > MAXIMO_BYTES) return "";

  const envio = new FormData();
  envio.append("file", new File([new Uint8Array(audio)], nombre, { type: tipo }));
  envio.append("model", "whisper-1");
  // Español fijo: el cliente es peruano, y decírselo mejora los nombres
  // propios y los números, que es lo que más dicta.
  envio.append("language", "es");

  try {
    const res = await fetch(WHISPER, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: envio,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.error("[transcribir] whisper dijo", res.status, (await res.text().catch(() => "")).slice(0, 200));
      return "";
    }
    const datos = (await res.json().catch(() => ({}))) as { text?: string };
    const texto = (datos.text ?? "").trim();
    return INVENTOS.some((f) => sinTildes(texto).includes(f)) ? "" : texto;
  } catch (err) {
    console.error("[transcribir] whisper no respondió:", err);
    return "";
  }
}

/** Baja el audio de WhatsApp y lo transcribe. Cadena vacía si algo falla. */
export async function transcribirAudioDeWhatsApp(
  mediaId: string,
  accessToken: string,
): Promise<string> {
  if (!process.env.OPENAI_API_KEY?.trim()) return "";
  try {
    const { url, mimeType } = await getMediaUrl({ mediaId, accessToken });
    const { buffer, contentType } = await downloadMedia({ downloadUrl: url, accessToken });
    const tipo = contentType || mimeType || "audio/ogg";
    const extension = tipo.includes("mpeg") ? "mp3" : tipo.includes("mp4") ? "m4a" : "ogg";
    return await transcribir(buffer, `nota.${extension}`, tipo);
  } catch (err) {
    console.error("[transcribir] no se pudo bajar el audio:", err);
    return "";
  }
}
