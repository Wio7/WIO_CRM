import { describe, expect, it } from 'vitest';

import {
  actionPayload,
  isMissingTable,
  latestByContact,
  manualResults,
  promiseState,
  resultLabel,
  validateAction,
  type CollectionAction,
} from './collection-actions';

const accion = (over: Partial<CollectionAction>): CollectionAction => ({
  id: Math.random().toString(36),
  contact_id: 'c1',
  plan_id: null,
  channel: 'llamada',
  result: 'contactado',
  promise_date: null,
  promise_amount: null,
  note: null,
  created_by: 'u1',
  created_at: '2026-11-01T15:00:00Z',
  ...over,
});

const HOY = '2026-11-07';

describe('latestByContact', () => {
  it('se queda con la gestión más reciente de cada contacto', () => {
    const m = latestByContact([
      accion({ id: 'a', created_at: '2026-11-03T10:00:00Z' }),
      accion({ id: 'b', created_at: '2026-11-05T10:00:00Z' }),
      accion({ id: 'c', contact_id: 'c2' }),
    ]);
    expect(m.get('c1')?.id).toBe('b');
    expect(m.get('c2')?.id).toBe('c');
  });
});

describe('promiseState', () => {
  it('vigente si la fecha no pasó, vencida si pasó', () => {
    expect(promiseState(accion({ result: 'promesa', promise_date: '2026-11-07' }), HOY)).toBe('vigente');
    expect(promiseState(accion({ result: 'promesa', promise_date: '2026-11-06' }), HOY)).toBe('vencida');
  });
  it('sin promesa no hay estado', () => {
    expect(promiseState(accion({ result: 'no_contesta' }), HOY)).toBeNull();
    expect(promiseState(undefined, HOY)).toBeNull();
  });
});

describe('validateAction', () => {
  const base = { channel: 'llamada' as const, result: 'contactado' as const, promiseDate: '', promiseAmount: '', note: '' };
  it('pide fecha futura o de hoy para una promesa', () => {
    expect(validateAction({ ...base, result: 'promesa' }, HOY)).toMatch(/fecha/);
    expect(validateAction({ ...base, result: 'promesa', promiseDate: '2026-11-01' }, HOY)).toMatch(/pasada/);
    expect(validateAction({ ...base, result: 'promesa', promiseDate: '2026-11-10' }, HOY)).toBeNull();
  });
  it('rechaza montos no positivos', () => {
    expect(validateAction({ ...base, promiseAmount: '0' }, HOY)).toMatch(/monto/);
    expect(validateAction({ ...base, promiseAmount: '350.50' }, HOY)).toBeNull();
  });
  it('tiene etiquetas en español', () => {
    expect(resultLabel('promesa')).toBe('Prometió pagar');
  });
});

describe('correcciones de la revisión (gestiones)', () => {
  const base = { channel: 'llamada' as const, result: 'contactado' as const, promiseDate: '', promiseAmount: '', note: '' };
  it('rechaza montos no numéricos o enormes', () => {
    expect(validateAction({ ...base, promiseAmount: 'abc' }, HOY)).toMatch(/monto/);
    expect(validateAction({ ...base, promiseAmount: '1e20' }, HOY)).toMatch(/monto/);
  });
  it('solo guarda fecha y monto prometidos si el resultado es promesa', () => {
    expect(actionPayload({ ...base, promiseAmount: '200', promiseDate: '2026-11-10', note: '  hola ' })).toEqual({
      channel: 'llamada', result: 'contactado', promise_date: null, promise_amount: null, note: 'hola',
    });
    expect(actionPayload({ ...base, result: 'promesa', promiseAmount: '200', promiseDate: '2026-11-10' })).toMatchObject({
      promise_date: '2026-11-10', promise_amount: 200, note: null,
    });
  });
  it('reconoce cuando falta la tabla (migración no aplicada)', () => {
    expect(isMissingTable({ code: '42P01', message: 'relation does not exist' })).toBe(true);
    expect(isMissingTable({ code: 'PGRST205', message: "Could not find the table 'public.collection_actions'" })).toBe(true);
    expect(isMissingTable({ code: '08006', message: 'network' })).toBe(false);
    expect(isMissingTable(null)).toBe(false);
  });
});

describe('manualResults', () => {
  it('sin 085 se puede registrar "Pase a legal" a mano', () => {
    expect(manualResults(false).map((r) => r.key)).toContain('pase_legal');
  });
  it('con 085 "Pase a legal" sale del diálogo (lo crea el traspaso)', () => {
    const keys = manualResults(true).map((r) => r.key);
    expect(keys).not.toContain('pase_legal');
    expect(keys).toContain('ultimatum');
  });
});
