import { describe, expect, it } from 'vitest';

import { validateAdvance } from './advance-payments';

const HOY = '2026-11-07';
const pend = [
  { id: 'v', number: 0, due_date: '2026-10-01' },
  { id: 'a', number: 1, due_date: '2026-12-01' },
  { id: 'b', number: 2, due_date: '2027-01-01' },
  { id: 'c', number: 3, due_date: '2027-02-01' },
  { id: 'd', number: 4, due_date: '2027-03-01' },
  { id: 'e', number: 5, due_date: '2027-04-01' },
];

describe('validateAdvance', () => {
  it('siguientes en orden', () => {
    expect(validateAdvance(pend, ['a', 'b', 'c'], HOY)).toEqual({ ok: true, mode: 'siguientes' });
    expect(validateAdvance(pend, ['c', 'a', 'b'], HOY)).toEqual({ ok: true, mode: 'siguientes' });
  });
  it('últimas', () => {
    expect(validateAdvance(pend, ['d', 'e'], HOY)).toEqual({ ok: true, mode: 'ultimas' });
  });
  it('salteadas es error', () => {
    expect(validateAdvance(pend, ['a', 'c'], HOY).ok).toBe(false);
  });
  it('incluir una vencida es error', () => {
    expect(validateAdvance(pend, ['v', 'a'], HOY).ok).toBe(false);
  });
  it('selección vacía o desconocida es error', () => {
    expect(validateAdvance(pend, [], HOY).ok).toBe(false);
    expect(validateAdvance(pend, ['zzz'], HOY).ok).toBe(false);
  });
});
