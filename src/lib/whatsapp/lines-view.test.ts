import { describe, expect, it } from 'vitest'
import { LINE_AREAS } from './lines'
import { AREA_LABELS, areaLabel, lineInitials, toLineRows, type LineView } from './lines-view'

const base: LineView = {
  id: 'l1', phone_number_id: '111', line_name: 'Principal', area: null, logo_url: null,
  is_primary: true, status: 'connected', disconnected_at: null, sort_order: 0,
}

describe('areaLabel', () => {
  it('todas las áreas válidas tienen etiqueta en español', () => {
    for (const a of LINE_AREAS) expect(AREA_LABELS[a]).toBeTruthy()
    expect(areaLabel('cobranzas')).toBe('Cobranzas')
    expect(areaLabel('tecnica')).toBe('Técnica')
    expect(areaLabel('administracion')).toBe('Administración')
    expect(areaLabel('posventa')).toBe('Posventa')
  })
  it('sin área o desconocida', () => {
    expect(areaLabel(null)).toBe('Sin área')
    expect(areaLabel('')).toBe('Sin área')
    expect(areaLabel('otra')).toBe('otra')
  })
})

describe('lineInitials', () => {
  it('toma hasta dos iniciales', () => {
    expect(lineInitials('Cobranzas Lima')).toBe('CL')
    expect(lineInitials('ventas')).toBe('V')
    expect(lineInitials('  ')).toBe('?')
  })
})

describe('toLineRows', () => {
  it('una línea conectada y principal', () => {
    const [r] = toLineRows([base])
    expect(r).toMatchObject({ id: 'l1', name: 'Principal', areaLabel: 'Sin área', phone: '111', statusKey: 'connected', statusLabel: 'Conectada', isPrimary: true, canReconnect: false, initials: 'P' })
  })
  it('desconexión suave: Desconectada + Reconectar', () => {
    const [r] = toLineRows([{ ...base, disconnected_at: '2026-11-18T00:00:00Z', status: 'disconnected' }])
    expect(r).toMatchObject({ statusKey: 'disconnected', statusLabel: 'Desconectada', canReconnect: true })
  })
  it('status disconnected sin disconnected_at: con error de registro, no es desconexión suave', () => {
    const [r] = toLineRows([{ ...base, status: 'disconnected' }])
    expect(r).toMatchObject({ statusKey: 'attention', statusLabel: 'Requiere atención', canReconnect: false })
  })
  it('sin línea principal marcada, la de menor sort_order se muestra como Principal; orden por sort_order', () => {
    const rows = toLineRows([
      { ...base, id: 'b', is_primary: false, sort_order: 2, line_name: 'B' },
      { ...base, id: 'a', is_primary: false, sort_order: 1, line_name: 'A' },
    ])
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(rows.map((r) => r.isPrimary)).toEqual([true, false])
  })
  it('con una principal marcada, solo esa lo es', () => {
    const rows = toLineRows([
      { ...base, id: 'a', is_primary: false, sort_order: 0 },
      { ...base, id: 'b', is_primary: true, sort_order: 1 },
    ])
    expect(rows.map((r) => r.isPrimary)).toEqual([false, true])
  })
})
