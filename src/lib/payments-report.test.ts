import { describe, expect, it } from 'vitest';

import { paymentsCsv, summarizePayments, type PaymentReportRow } from './payments-report';

const fila = (over: Partial<PaymentReportRow> = {}): PaymentReportRow => ({
  amount: 100,
  method: 'yape',
  registered_by: 'u1',
  voided_at: null,
  currency: 'PEN',
  ...over,
});

describe('summarizePayments', () => {
  it('suma por método y total; acepta montos como texto', () => {
    const r = summarizePayments([
      fila({ amount: 100.1, method: 'yape' }),
      fila({ amount: '200.2', method: 'yape' }),
      fila({ amount: 50, method: 'efectivo' }),
      fila({ amount: 10, method: null }),
    ]);
    expect(r.total).toBe(360.3);
    expect(r.byMethod).toEqual({ yape: 300.3, efectivo: 50, 'Sin método': 10 });
    expect(r.voided).toBe(0);
  });

  it('los anulados no suman al total ni al método, sí a voided', () => {
    const r = summarizePayments([
      fila({ amount: 100, method: 'yape' }),
      fila({ amount: 40, method: 'yape', voided_at: '2026-11-08T15:00:00Z' }),
    ]);
    expect(r.total).toBe(100);
    expect(r.byMethod).toEqual({ yape: 100 });
    expect(r.voided).toBe(40);
  });

  it('sin filas da ceros', () => {
    expect(summarizePayments([])).toEqual({ byMethod: {}, total: 0, voided: 0 });
  });
});

describe('paymentsCsv', () => {
  it('separa con punto y coma y escribe el estado', () => {
    const csv = paymentsCsv([
      fila({ paid_on: '2026-11-08', client: 'Ana', unit: 'A-1', installment: 3, reference: 'OP1', registered_by_name: 'Luis' }),
      fila({ amount: 40, voided_at: '2026-11-09T01:00:00Z', void_reason: 'error' }),
    ]);
    const [head, a, b] = csv.split('\n');
    expect(head.split(';')[0]).toBe('Fecha de pago');
    expect(a).toContain('2026-11-08;Ana;A-1;3;100.00;PEN;yape;OP1;Luis;Vigente');
    expect(b).toContain('Anulado');
    expect(b).toContain('error');
  });

  it('neutraliza fórmulas y protege separadores', () => {
    const csv = paymentsCsv([fila({ client: '=HYPERLINK("x")', reference: 'a;b', void_reason: null })]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"a;b"');
  });
});
