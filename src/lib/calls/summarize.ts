// ============================================================
// Turn a call transcript into a summary + a next-step recommendation.
//
// Reuses `generateReply` (src/lib/ai/generate.ts) so this runs on
// whichever provider the account already configured — no second LLM
// integration. It does NOT reuse `buildSystemPrompt`, which is wired
// to the WhatsApp reply persona ("write the next reply the business
// should send"); a call summary needs its own instructions.
//
// The recommendation is constrained to the same five values the
// `call_results.ai_recommendation` CHECK allows, so the column stays
// filterable. If the model returns anything else, the recommendation
// is dropped rather than stored as free text — a value outside the
// enum would fail the insert and lose the summary along with it.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'

export const RECOMMENDATIONS = [
  'alta_intencion',
  'pedir_info',
  'reagendar',
  'no_interesado',
  'no_calificado',
] as const

export type CallRecommendation = (typeof RECOMMENDATIONS)[number]

export interface CallSummary {
  summary: string
  recommendation: CallRecommendation | null
}

const SYSTEM_PROMPT = `Eres un analista comercial de una empresa inmobiliaria en Perú.
Recibirás la transcripción de una llamada telefónica entre un asesor de ventas y un prospecto.

Responde SIEMPRE en este formato exacto, sin texto adicional:

RESUMEN: <dos o tres frases en español sobre lo que ocurrió en la llamada: qué pidió el prospecto, qué se le ofreció y en qué quedaron>
RECOMENDACION: <una sola de estas palabras: alta_intencion, pedir_info, reagendar, no_interesado, no_calificado>

Criterios para la recomendación:
- alta_intencion: pidió precios concretos, separó, agendó visita o mostró intención clara de compra.
- pedir_info: mostró interés pero necesita más información antes de decidir.
- reagendar: no era buen momento y pidió que le llamaran después.
- no_interesado: dijo explícitamente que no le interesa.
- no_calificado: no cumple el perfil (presupuesto, zona, o no es la persona indicada).

No inventes datos que no estén en la transcripción.`

/**
 * Parse the constrained response format. Tolerant of a missing or
 * malformed RECOMENDACION line: the summary is the valuable part and
 * shouldn't be thrown away because the label didn't parse.
 */
export function parseCallSummary(raw: string): CallSummary {
  const summaryMatch = raw.match(/RESUMEN:\s*([\s\S]*?)(?:\n\s*RECOMENDACION:|$)/i)
  const recMatch = raw.match(/RECOMENDACION:\s*([a-z_]+)/i)

  const summary = (summaryMatch?.[1] ?? raw).trim()
  const candidate = recMatch?.[1]?.trim().toLowerCase()
  const recommendation = RECOMMENDATIONS.includes(candidate as CallRecommendation)
    ? (candidate as CallRecommendation)
    : null

  return { summary, recommendation }
}

/**
 * Summarize one transcript for an account. Returns null when the
 * account has no usable AI config — the caller records the transcript
 * without a summary rather than failing the whole job.
 *
 * `requireActive: false` on purpose: `ai_configs.is_active` is the
 * master switch for the WhatsApp reply assistant. An account that
 * turned auto-replies off still expects its call summaries.
 */
export async function summarizeCall(
  db: SupabaseClient,
  accountId: string,
  transcript: string,
): Promise<CallSummary | null> {
  const config = await loadAiConfig(db, accountId, { requireActive: false })
  if (!config) return null

  const result = await generateReply({
    config,
    systemPrompt: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Transcripción de la llamada:\n\n${transcript}`,
      },
    ],
  })

  return parseCallSummary(result.text)
}
