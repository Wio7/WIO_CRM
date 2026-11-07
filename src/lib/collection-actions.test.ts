import { describe, expect, it } from 'vitest';

import {
  latestByContact,
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
