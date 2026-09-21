import { AiError, type AiConfig, type ChatMessage, type GenerateResult } from './types'
import { AGENDA_SENTINEL_RE, HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  }

  let raw: string
  switch (config.provider) {
    case 'openai':
      raw = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      raw = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(raw)
}

/**
 * Split the raw model output into `{ text, handoff, cita }`. The handoff
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. El sello de cita (`[[AGENDAR:<ISO>|<tipo>]]`, 058) se saca igual:
 * el cliente nunca ve ninguno de los dos.
 */
export function parseGeneration(raw: string): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  let text = raw.split(HANDOFF_SENTINEL).join('')

  let cita: GenerateResult['cita'] = null
  const sello = text.match(AGENDA_SENTINEL_RE)
  if (sello) {
    const cuandoIso = (sello[1] ?? '').trim()
    if (cuandoIso && !Number.isNaN(Date.parse(cuandoIso))) {
      cita = { cuandoIso, tipo: (sello[2] ?? 'videollamada').trim().toLowerCase() }
    }
    text = text.replace(AGENDA_SENTINEL_RE, '')
  }
  // Un modelo que se pasa de listo puede dejar varios sellos: fuera todos,
  // que uno suelto en el chat se lee fatal.
  while (AGENDA_SENTINEL_RE.test(text)) text = text.replace(AGENDA_SENTINEL_RE, '')

  return { text: text.trim(), handoff, cita }
}
