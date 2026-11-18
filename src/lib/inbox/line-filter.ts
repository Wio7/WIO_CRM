// Lógica pura de la bandeja con varias líneas de WhatsApp: cuándo mostrar la
// etiqueta de línea, el filtro "Línea" y la URL de media por línea. Sin React
// ni base. Las conversaciones antiguas (line_id NULL) cuentan como la línea
// principal.
import { areaLabel, lineInitials, toLineRows, type LineView } from '@/lib/whatsapp/lines-view'

export type ConversationLineRef = { line_id?: string | null }

export type ConversationLineLabel = {
  lineId: string
  name: string
  logoUrl: string | null
  initials: string
  areaLabel: string
}

/** Etiqueta y filtro de línea solo existen con 2 o más líneas. */
export function showLineUi(lines: LineView[]): boolean {
  return lines.length > 1
}

function primaryLineId(lines: LineView[]): string | null {
  return toLineRows(lines).find((r) => r.isPrimary)?.id ?? null
}

/** Línea efectiva de una conversación: su line_id o, si es NULL, la principal. */
export function effectiveLineId(conv: ConversationLineRef, lines: LineView[]): string | null {
  return conv.line_id ?? primaryLineId(lines)
}

/** Etiqueta a pintar, o null (una sola línea, o la línea ya no existe). */
export function conversationLineLabel(
  conv: ConversationLineRef,
  lines: LineView[],
): ConversationLineLabel | null {
  if (!showLineUi(lines)) return null
  const id = effectiveLineId(conv, lines)
  const line = id ? lines.find((l) => l.id === id) : undefined
  if (!line) return null
  return {
    lineId: line.id,
    name: line.line_name,
    logoUrl: line.logo_url,
    initials: lineInitials(line.line_name),
    areaLabel: areaLabel(line.area),
  }
}

/** selectedLineId null = "Todas". */
export function matchesLineFilter(
  conv: ConversationLineRef,
  selectedLineId: string | null,
  lines: LineView[],
): boolean {
  if (!selectedLineId) return true
  return effectiveLineId(conv, lines) === selectedLineId
}

const MEDIA_PREFIX = '/api/whatsapp/media/'

/**
 * El id de media de una línea puede no bajar con el token de la principal:
 * el proxy recibe ?line_id=. Solo toca URLs del proxy y sin line_id previo.
 */
export function mediaUrlForLine(url: string, lineId: string | null | undefined): string {
  if (!lineId || !url.startsWith(MEDIA_PREFIX)) return url
  if (/[?&]line_id=/.test(url)) return url
  return `${url}${url.includes('?') ? '&' : '?'}line_id=${encodeURIComponent(lineId)}`
}

/** Mismo sentido que el aviso de hoy: hay al menos una línea conectada y viva. */
export function isWhatsappConnected(lines: LineView[]): boolean {
  return lines.some((l) => !l.disconnected_at && l.status === 'connected')
}
