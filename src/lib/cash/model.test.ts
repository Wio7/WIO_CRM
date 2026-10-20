import { describe, expect, it } from 'vitest';
import { parseAmount, validateCommand } from './model';
describe('cash amounts and commands', () => {
  it('preserves decimal cents without rounding errors', () => {
    expect(parseAmount('0.29')).toBe(29);
    expect(parseAmount('123,45')).toBe(12345);
    expect(parseAmount('5000')).toBe(500000);
  });
  it.each([
    '0',
    '-1',
    '1.005',
    '1e5',
    'Infinity',
    '1,000.00',
    '1000000000',
    '',
    'NaN',
  ])('rejects invalid amount %s', (value) => {
    expect(() => parseAmount(value)).toThrow();
  });
  const entry = {
    action: 'entry',
    companyId: '00000000-0000-0000-0000-000000000002',
    requestId: '00000000-0000-0000-0000-000000000001',
    kind: 'expense',
    amountCents: 100,
    concept: 'Taxi',
    counterparty: 'Proveedor',
    date: '2026-01-05',
  };
  it('accepts valid entries and rejects fractional cents or invalid dates', () => {
    expect(validateCommand(entry)).toEqual(entry);
    expect(() => validateCommand({ ...entry, amountCents: 1.5 })).toThrow();
    expect(() => validateCommand({ ...entry, date: '2026-02-30' })).toThrow();
    expect(() => validateCommand({ ...entry, date: '2099-01-01' })).toThrow();
  });
  it('rejects blank concepts and income attached to a budget', () => {
    expect(() => validateCommand({ ...entry, concept: ' ' })).toThrow();
    expect(() =>
      validateCommand({ ...entry, kind: 'income', budgetId: entry.requestId })
    ).toThrow();
  });
});
