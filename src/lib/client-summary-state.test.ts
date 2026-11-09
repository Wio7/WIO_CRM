import { describe, expect, it } from 'vitest'

import { estadoResumen } from './client-summary-state'

describe('estadoResumen', () => {
  it('sin acceso se muestra aunque el plan no sea visible', () => {
    expect(estadoResumen({ contactId: 'c1', hayPlan: false, sinAcceso: true })).toBe('sin-acceso')
  })
  it('con acceso y sin plan no pinta nada (interesado)', () => {
    expect(estadoResumen({ contactId: 'c1', hayPlan: false, sinAcceso: false })).toBe('oculto')
  })
  it('con acceso y plan pinta la tarjeta completa', () => {
    expect(estadoResumen({ contactId: 'c1', hayPlan: true, sinAcceso: false })).toBe('completo')
  })
  it('sin contacto no pinta nada', () => {
    expect(estadoResumen({ contactId: null, hayPlan: false, sinAcceso: true })).toBe('oculto')
  })
})
