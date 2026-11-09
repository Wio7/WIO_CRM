import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { ejecutarHerramienta, type ContextoAsistente } from './tools'

// Base falsa: el contacto existe, pero el plan no es visible (RLS 084 para
// quien no tiene acceso al cronograma). `acceso` es lo que responde my_module_access.
function ctxCon(acceso: Record<string, boolean> | null): ContextoAsistente {
  const contacto = { id: 'c1', name: 'Ana Perez', phone: '999111222', dni: null, email: null, lead_source: null }
  const db = {
    rpc: () =>
      Promise.resolve(acceso ? { data: acceso, error: null } : { data: null, error: { code: 'PGRST202', message: 'missing' } }),
    from: (tabla: string) => {
      const filas = tabla === 'contacts' ? [contacto] : []
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'not', 'order', 'limit', 'gte', 'lt', 'ilike', 'or']) {
        chain[m] = () => chain
      }
      chain.maybeSingle = () => Promise.resolve({ data: null, error: null })
      chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: filas, error: null, count: 0 }).then(ok)
      return chain
    },
  }
  return { db: db as unknown as SupabaseClient, userId: 'u1', accountId: 'a1', rol: 'agent', area: 'ventas', nombre: 'Ana' }
}

describe('resumen_cliente sin acceso a cobranzas (084)', () => {
  it('dice sin acceso aunque el plan no sea visible, nunca "no compró"', async () => {
    const r = await ejecutarHerramienta(ctxCon({ cobranzas: false }), 'resumen_cliente', JSON.stringify({ buscar: 'Ana Perez' }))
    const texto = JSON.stringify(r.datos)
    expect(texto).toContain('Sin acceso a cobranzas')
    expect(texto).not.toContain('todavía no compró')
  })

  it('antes de la 084 (sin la función) conserva el comportamiento previo', async () => {
    const r = await ejecutarHerramienta(ctxCon(null), 'resumen_cliente', JSON.stringify({ buscar: 'Ana Perez' }))
    expect(JSON.stringify(r.datos)).toContain('todavía no compró')
  })
})
