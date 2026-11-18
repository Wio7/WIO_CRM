import { describe, expect, it } from 'vitest'
import type { LineView } from '@/lib/whatsapp/lines-view'
import {
  conversationLineLabel,
  isWhatsappConnected,
  matchesLineFilter,
  mediaUrlForLine,
  showLineUi,
} from './line-filter'

const mk = (over: Partial<LineView> & { id: string }): LineView => ({
  phone_number_id: over.id + '-p', line_name: 'Línea ' + over.id, area: null, logo_url: null,
  is_primary: false, status: 'connected', disconnected_at: null, sort_order: 0, ...over,
})
const A = mk({ id: 'a', line_name: 'Ventas Golden', is_primary: true, sort_order: 0, area: 'ventas' })
const B = mk({ id: 'b', line_name: 'Cobranzas', sort_order: 1, area: 'cobranzas', logo_url: 'https://x/l.png' })

describe('showLineUi', () => {
  it('solo con 2 o más líneas', () => {
    expect(showLineUi([])).toBe(false)
    expect(showLineUi([A])).toBe(false)
    expect(showLineUi([A, B])).toBe(true)
  })
})

describe('conversationLineLabel', () => {
  it('null con una sola línea (la bandeja queda igual que hoy)', () => {
    expect(conversationLineLabel({ line_id: 'a' }, [A])).toBeNull()
  })
  it('con 2+ líneas devuelve nombre, logo, iniciales y área en español', () => {
    expect(conversationLineLabel({ line_id: 'b' }, [A, B])).toEqual({
      lineId: 'b', name: 'Cobranzas', logoUrl: 'https://x/l.png', initials: 'C', areaLabel: 'Cobranzas',
    })
  })
  it('line_id NULL cuenta como la principal', () => {
    expect(conversationLineLabel({ line_id: null }, [B, A])?.name).toBe('Ventas Golden')
    expect(conversationLineLabel({}, [A, B])?.lineId).toBe('a')
  })
  it('línea desconocida (borrada): sin etiqueta', () => {
    expect(conversationLineLabel({ line_id: 'zzz' }, [A, B])).toBeNull()
  })
})

describe('matchesLineFilter', () => {
  const lines = [A, B]
  it('sin filtro (Todas) deja pasar todo', () => {
    expect(matchesLineFilter({ line_id: 'b' }, null, lines)).toBe(true)
    expect(matchesLineFilter({ line_id: null }, null, lines)).toBe(true)
  })
  it('filtra por line_id', () => {
    expect(matchesLineFilter({ line_id: 'b' }, 'b', lines)).toBe(true)
    expect(matchesLineFilter({ line_id: 'a' }, 'b', lines)).toBe(false)
  })
  it('NULL cuenta como la principal', () => {
    expect(matchesLineFilter({ line_id: null }, 'a', lines)).toBe(true)
    expect(matchesLineFilter({ line_id: undefined }, 'b', lines)).toBe(false)
  })
})

describe('mediaUrlForLine', () => {
  it('agrega ?line_id= a la URL del proxy de media', () => {
    expect(mediaUrlForLine('/api/whatsapp/media/123', 'b')).toBe('/api/whatsapp/media/123?line_id=b')
  })
  it('codifica el id y respeta una query previa', () => {
    expect(mediaUrlForLine('/api/whatsapp/media/1?x=1', 'a b')).toBe('/api/whatsapp/media/1?x=1&line_id=a%20b')
  })
  it('no cambia nada sin line_id, con otra URL o si ya trae line_id', () => {
    expect(mediaUrlForLine('/api/whatsapp/media/1', null)).toBe('/api/whatsapp/media/1')
    expect(mediaUrlForLine('https://cdn/x.png', 'b')).toBe('https://cdn/x.png')
    expect(mediaUrlForLine('/api/whatsapp/media/1?line_id=z', 'b')).toBe('/api/whatsapp/media/1?line_id=z')
  })
})

describe('isWhatsappConnected', () => {
  it('conectado si alguna línea está connected y sin desconexión suave', () => {
    expect(isWhatsappConnected([A, B])).toBe(true)
    expect(isWhatsappConnected([mk({ id: 'x', disconnected_at: '2026-01-01' }), B])).toBe(true)
  })
  it('no conectado sin líneas, o si todas están desconectadas o con falla', () => {
    expect(isWhatsappConnected([])).toBe(false)
    expect(isWhatsappConnected([mk({ id: 'x', disconnected_at: '2026-01-01' })])).toBe(false)
    expect(isWhatsappConnected([mk({ id: 'y', status: 'disconnected' })])).toBe(false)
  })
})

import { connectionBanner, isStaleLinesResponse, validLineSelection } from './line-filter'

describe('validLineSelection', () => {
  it('conserva una selección que sigue existiendo', () => {
    expect(validLineSelection('b', [A, B])).toBe('b')
  })
  it('devuelve null si la línea ya no existe o hay una sola línea', () => {
    expect(validLineSelection('zzz', [A, B])).toBeNull()
    expect(validLineSelection('b', [A])).toBeNull()
    expect(validLineSelection(null, [A, B])).toBeNull()
  })
  it('un id viejo ya no oculta todo: el filtro validado deja pasar todo', () => {
    const sel = validLineSelection('zzz', [A, B])
    expect(matchesLineFilter({ line_id: 'a' }, sel, [A, B])).toBe(true)
  })
})

describe('isStaleLinesResponse', () => {
  it('es vieja si la generación cambió desde que empezó', () => {
    expect(isStaleLinesResponse(1, 2)).toBe(true)
    expect(isStaleLinesResponse(2, 2)).toBe(false)
  })
})

describe('connectionBanner', () => {
  it('null (sin aviso) mientras carga', () => {
    expect(connectionBanner({ loading: true, error: false, lines: [] })).toBeNull()
  })
  it('null si falló la carga y no hay líneas en caché', () => {
    expect(connectionBanner({ loading: false, error: true, lines: [] })).toBeNull()
  })
  it('con líneas en caché usa su estado aunque el último intento fallara', () => {
    expect(connectionBanner({ loading: false, error: true, lines: [A] })).toBe(true)
  })
  it('false solo cuando cargó bien y no hay línea conectada', () => {
    expect(connectionBanner({ loading: false, error: false, lines: [] })).toBe(false)
    expect(connectionBanner({ loading: false, error: false, lines: [A] })).toBe(true)
  })
})
