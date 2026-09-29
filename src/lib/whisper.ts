// ============================================================
// Transcripción de voz con Whisper (OpenAI), compartida por las rutas
// que reciben audio: /api/client/voice (el cliente) y
// /api/assistant/voice (el equipo).
//
// La llave vive SOLO en el servidor: una app en el navegador no puede
// guardar un secreto.
// ============================================================

/** Un minuto y medio de voz sobra para un mensaje y no cuesta casi nada. */
export const MAXIMO_BYTES = 8 * 1024 * 1024;

const WHISPER = "https://api.openai.com/v1/audio/transcriptions";

/**
 * Lo que Whisper se inventa cuando el audio no tiene voz.
 *
 * Con silencio o ruido no devuelve vacío: devuelve una de las frases que
 * aprendió de tanto video subtitulado. Comprobado contra producción el
 * 2026-09-17 con un tono puro — contestó "Subtítulos realizados por la
 * comunidad de Amara.org". Si eso llegara al cuadro de texto, pensarían
 * que la app se volvió loca.
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

const sinTildes = (t: string) =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** El texto tal cual, o vacío si es uno de los inventos de Whisper. */
export function limpiarInventos(texto: string): string {
  const t = texto.trim();
  return INVENTOS.some((f) => sinTildes(t).includes(f)) ? "" : t;
}

export type ResultadoWhisper = { ok: true; texto: string } | { ok: false; status: number };

/** Manda el audio a Whisper en español y devuelve lo que se dijo. Nunca lanza. */
export async function transcribirAudio(audio: File, apiKey: string): Promise<ResultadoWhisper> {
  const envio = new FormData();
  envio.append("file", audio, audio.name || "voz.webm");
  envio.append("model", "whisper-1");
  // Español fijo: decírselo mejora bastante los nombres propios y los
  // números ("mi cuota de mayo", "operación 884512").
  envio.append("language", "es");

  let res: Response;
  try {
    res = await fetch(WHISPER, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: envio,
    });
  } catch (err) {
    console.error("[voice] whisper unreachable:", err);
    return { ok: false, status: 502 };
  }

  if (!res.ok) {
    console.error("[voice] whisper said", res.status, await res.text().catch(() => ""));
    return { ok: false, status: res.status };
  }

  const datos = (await res.json().catch(() => ({}))) as { text?: string };
  return { ok: true, texto: limpiarInventos(datos.text ?? "") };
}
