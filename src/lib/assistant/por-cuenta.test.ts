import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// Lo que devuelve la base según la tabla que se consulte.
const filas: Record<string, Record<string, unknown> | null> = {}

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    let tabla = ''
    const chain = {
      from: (t: string) => ((tabla = t), chain),
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve({ data: filas[tabla] ?? null, error: null }),
    }
    return chain
  },
}))

const catalogoDeGolden = vi.fn()
vi.mock('@/lib/golden/catalogo', () => ({
  catalogoDeGolden: () => catalogoDeGolden(),
  esCuentaDeGolden: (id: string) => id === 'golden',
}))

import { ejecutarHerramienta, marcaDeLaCuenta, type ContextoAsistente } from './tools'
import { instrucciones } from './run'

const ctx = (accountId: string): ContextoAsistente => ({
  db: {} as SupabaseClient,
  userId: 'u1',
  accountId,
  rol: 'owner',
  area: null,
  nombre: 'Julio',
})

beforeEach(() => {
  for (const k of Object.keys(filas)) delete filas[k]
  catalogoDeGolden.mockReset()
})

describe('asistente por cuenta', () => {
  it('usa la marca de la cuenta', async () => {
    filas.accounts = { name: 'Julio Palli', brand_name: 'Broker Home' }
    expect(await marcaDeLaCuenta('broker')).toBe('Broker Home')
    expect(await marcaDeLaCuenta('golden')).toBe('Golden Habitat')
  })

  it('se presenta con la marca y no como Golden', () => {
    const texto = instrucciones(ctx('broker'), 'Broker Home')
    expect(texto).toContain('Eres el Asistente de Broker Home')
    expect(texto).not.toContain('Asistente Golden')
    expect(instrucciones(ctx('golden'))).toContain('Eres el Asistente Golden')
  })

  it('el catálogo de otra cuenta es su propia información, nunca el de Golden', async () => {
    filas.ai_configs = { system_prompt: 'Lotes salida a Arequipa desde 37 mil dólares' }
    const r = await ejecutarHerramienta(ctx('broker'), 'catalogo', '{}')
    expect(JSON.stringify(r.datos)).toContain('salida a Arequipa')
    expect(catalogoDeGolden).not.toHaveBeenCalled()
  })

  it('sin información cargada lo dice en vez de inventar', async () => {
    const r = await ejecutarHerramienta(ctx('broker'), 'catalogo', '{}')
    expect(r.datos).toHaveProperty('error')
  })

  it('buscar_lote no mira los planos de Golden desde otra cuenta', async () => {
    const r = await ejecutarHerramienta(ctx('broker'), 'buscar_lote', '{"area_minima":100}')
    expect(r.datos).toHaveProperty('error')
    expect(catalogoDeGolden).not.toHaveBeenCalled()
  })
})
