// ============================================================
// Speech-to-text for call recordings (OpenAI Whisper).
//
// This is the first server-side multipart upload in the codebase —
// everything else either sends media by public URL or POSTs raw bytes.
//
// Key sourcing: Whisper is OpenAI-only, so it reuses the account's
// `ai_configs.embeddings_api_key`, which is already documented as an
// OpenAI-compatible key and is independent of both the provider choice
// and the AI master switch (an Anthropic-provider account with a
// knowledge base already has one). The settings UI labels that field
// as powering semantic search AND call transcription — quietly
// widening what a pasted key is used for would not be honest.
//
// No key configured is not an error: the call still keeps its
// recording and duration, it just isn't transcribed.
// ============================================================

import { AiError } from '@/lib/ai/types'
import { providerHttpError, toNetworkError } from '@/lib/ai/providers/shared'

const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions'
const TRANSCRIBE_MODEL = 'whisper-1'
const TIMEOUT_MS = 120_000

/** Twilio caps a single recording well under this; the guard is for sanity. */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024

export interface TranscribeArgs {
  apiKey: string
  bytes: Uint8Array
  contentType: string
  /** ISO-639-1. Pinning it improves accuracy over letting Whisper guess. */
  language?: string
}

export async function transcribeAudio(args: TranscribeArgs): Promise<string> {
  if (args.bytes.byteLength === 0) {
    throw new AiError('Recording is empty', { code: 'empty_audio', status: 400 })
  }
  if (args.bytes.byteLength > MAX_AUDIO_BYTES) {
    throw new AiError('Recording is too large to transcribe', {
      code: 'audio_too_large',
      status: 413,
    })
  }

  const form = new FormData()
  form.append('model', TRANSCRIBE_MODEL)
  form.append('language', args.language ?? 'es')
  form.append(
    'file',
    // Whisper infers the container from the filename extension, so the
    // name matters even though the bytes carry the real format.
    new Blob([args.bytes as unknown as BlobPart], { type: args.contentType }),
    args.contentType.includes('wav') ? 'call.wav' : 'call.mp3',
  )

  let res: Response
  try {
    res = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI transcription', res)
  }

  const json = (await res.json().catch(() => null)) as { text?: string } | null
  const text = json?.text?.trim()
  if (!text) {
    throw new AiError('Transcription returned no text', {
      code: 'empty_response',
      status: 502,
    })
  }
  return text
}
