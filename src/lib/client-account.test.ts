import { describe, expect, it } from 'vitest';

import { planHealth, summarizeClientAccount, type PlanBalanceRow } from './client-account';

const plan = (over: Partial<PlanBalanceRow>): PlanBalanceRow => ({
  plan_id: 'p',
  currency: 'PEN',
  total_amount: 30000,
  down_payment: 3000,
  status: 'activo',
  paid_amount: 5000,
  paid_count: 5,
  pending_amount: 22000,
  pending_count: 22,
  overdue_count: 0,
  overdue_amount: 0,
  next_due_date: '2026-12-05',
  ...over,
});

describe('summarizeClientAccount', () => {
  it('suma inicial + cuotas pagadas, pendiente, vencido y la próxima fecha', () => {
    const [t] = summarizeClientAccount([
      plan({}),
      plan({ plan_id: 'q', total_amount: '10000', down_payment: '1000', paid_amount: '0',
        pending_amount: '9000', overdue_count: 2, overdue_amount: '800', next_due_date: '2026-10-05' }),
    ]);
    expect(t).toMatchObject({
      currency: 'PEN', total: 40000, paid: 9000, pending: 31000,
      overdue: 800, overdueCount: 2, nextDue: '2026-10-05', activePlans: 2,
    });
  });

  it('separa monedas y no cuenta planes cancelados', () => {
    const out = summarizeClientAccount([
      plan({ currency: 'USD' }),
      plan({ status: 'cancelado' }),
      plan({}),
    ]);
    expect(out.map((t) => t.currency)).toEqual(['USD', 'PEN']);
    expect(out[1].total).toBe(30000);
  });

  it('sin planes devuelve lista vacía', () => {
    expect(summarizeClientAccount([])).toEqual([]);
  });
});

describe('planHealth', () => {
  it('clasifica cada plan', () => {
    expect(planHealth(plan({}))).toBe('al-dia');
    expect(planHealth(plan({ overdue_count: 1 }))).toBe('con-atraso');
    expect(planHealth(plan({ pending_count: 0 }))).toBe('pagado');
    expect(planHealth(plan({ status: 'pagado' }))).toBe('pagado');
    expect(planHealth(plan({ status: 'suspendido' }))).toBe('otro');
  });
});
