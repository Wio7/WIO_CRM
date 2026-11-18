// Presentación de las líneas de WhatsApp: etiquetas en español y filas
// listas para pintar. Sin dependencias de React ni de la base.
import type { LINE_AREAS } from './lines'

type LineArea = (typeof LINE_AREAS)[number]

export const AREA_LABELS: Record<LineArea, string> = {
  marketing: 'Marketing',
  legal: 'Legal',
  cobranzas: 'Cobranzas',
  ventas: 'Ventas',
  gerencia: 'Gerencia',
  contabilidad: 'Contabilidad',
  tecnica: 'Técnica',
  promueve: 'Promueve',
  administracion: 'Administración',
  posventa: 'Posventa',
}

/** Campos públicos de una línea (lo que devuelve GET /api/whatsapp/config en `lines`). */
export type LineView = {
  id: string
  phone_number_id: string
  waba_id?: string | null
  line_name: string
  area: string | null
  logo_url: string | null
  is_primary: boolean
  status: string
  disconnected_at: string | null
  sort_order?: number | null
}

export type LineStatusKey = 'connected' | 'disconnected' | 'attention'

export type LineRow = {
  id: string
  name: string
  area: string | null
  areaLabel: string
  logoUrl: string | null
  initials: string
  phone: string
  statusKey: LineStatusKey
  statusLabel: string
  isPrimary: boolean
  canReconnect: boolean
}

export function areaLabel(area: string | null | undefined): string {
  if (!area) return 'Sin área'
  return (AREA_LABELS as Record<string, string>)[area] ?? area
}

export function lineInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  return words.slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('')
}

/**
 * Filas en orden de sort_order. Principal = la marcada; si ninguna lo está,
 * la primera (misma regla que el servidor). "Desconectada" solo cuando hay
 * desconexión suave (disconnected_at); un status 'disconnected' sin eso es un
 * registro fallido con token vigente: "Requiere atención".
 */
export function toLineRows(lines: LineView[]): LineRow[] {
  const sorted = [...lines].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  const primaryId = (sorted.find((l) => l.is_primary) ?? sorted[0])?.id
  return sorted.map((l) => {
    const soft = Boolean(l.disconnected_at)
    const statusKey: LineStatusKey = soft ? 'disconnected' : l.status === 'connected' ? 'connected' : 'attention'
    return {
      id: l.id,
      name: l.line_name,
      area: l.area,
      areaLabel: areaLabel(l.area),
      logoUrl: l.logo_url,
      initials: lineInitials(l.line_name),
      phone: l.phone_number_id,
      statusKey,
      statusLabel: soft ? 'Desconectada' : l.status === 'connected' ? 'Conectada' : 'Requiere atención',
      isPrimary: l.id === primaryId,
      canReconnect: soft,
    }
  })
}
