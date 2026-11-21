import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './defaults'

describe('buildSystemPrompt: citas', () => {
  it('sin agenda prohíbe decir que la cita quedó registrada', () => {
    const p = buildSystemPrompt({ userPrompt: 'Broker Home', mode: 'auto_reply', agenda: null, nuncaSeCalla: true })
    expect(p).toMatch(/CANNOT book/)
    expect(p).toMatch(/queda registrado/)
  })
  it('con agenda enseña el sello y no la prohibición', () => {
    const p = buildSystemPrompt({ userPrompt: 'x', mode: 'auto_reply', agenda: { horasLibres: 'lunes 10:00 (2026-11-23T15:00:00Z)' } })
    expect(p).toMatch(/\[\[AGENDAR:/)
    expect(p).not.toMatch(/CANNOT book/)
  })
  it('el borrador del asesor no lleva reglas de agenda', () => {
    const p = buildSystemPrompt({ userPrompt: 'x', mode: 'draft' })
    expect(p).not.toMatch(/CANNOT book|AGENDAR/)
  })
})

describe('buildSystemPrompt: no repetir', () => {
  it('pide no repetir saludo ni descripción, en respuestas y borradores', () => {
    for (const mode of ['auto_reply', 'draft'] as const) {
      expect(buildSystemPrompt({ userPrompt: 'x', mode })).toMatch(/never repeat a greeting/)
    }
  })
})
