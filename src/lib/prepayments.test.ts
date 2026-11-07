import { describe, expect, it } from 'vitest';

import { planPrepayment, type PendingInstallment } from './prepayments';

const HOY = '2026-11-07';
const cuotas = (montos: number[], primera = '2026-12-05'): PendingInstallment[] =>
  montos.map((amount, i) => {
    const [y, m] = primera.split('-').map(Number);
    const mes = m - 1 + i;
    const date = `${y + Math.floor(mes / 12)}-${String((mes % 12) + 1).padStart(2, '0')}-05`;
    return { id: `i${i + 1}`, number: i + 1, amount, due_date: date };
  });

const sumaRebajas = (r: ReturnType<typeof planPrepayment>, base: PendingInstallment[]) =>
  Math.round(
    (r.changes ?? []).reduce((s, c) => s + (Number(base.find((b) => b.id === c.id)!.amount) - c.newAmount), 0) * 100,
  ) / 100;

describe('planPrepayment — reducir plazo', () => {
  it('cubre desde la última cuota hacia atrás', () => {
    const base = cuotas([500, 500, 500, 500]);
    const r = planPrepayment(base, 1200, 'reducir_plazo', HOY);
    expect(r.error).toBeNull();
    expect(r.changes).toEqual([
      { id: 'i4', newAmount: 0, status: 'adelantada' },
      { id: 'i3', newAmount: 0, status: 'adelantada' },
      { id: 'i2', newAmount: 300, status: 'pendiente' },
    ]);
    expect(sumaRebajas(r, base)).toBe(1200);
  });
});

describe('planPrepayment — reducir cuota', () => {
  it('reparte en céntimos exactos entre las cuotas futuras', () => {
    const base = cuotas([500, 500, 500]);
    const r = planPrepayment(base, 100, 'reducir_cuota', HOY);
    expect(r.error).toBeNull();
    expect(sumaRebajas(r, base)).toBe(100);
    const nuevos = r.changes!.map((c) => c.newAmount).sort();
    expect(nuevos).toEqual([466.66, 466.67, 466.67]);
  });

  it('ninguna cuota baja de cero aunque sean desiguales', () => {
    const base = cuotas([10, 500, 500]);
    const r = planPrepayment(base, 600, 'reducir_cuota', HOY);
    expect(r.error).toBeNull();
    expect(r.changes!.every((c) => c.newAmount >= 0)).toBe(true);
    expect(sumaRebajas(r, base)).toBe(600);
    expect(r.changes!.find((c) => c.id === 'i1')).toEqual({ id: 'i1', newAmount: 0, status: 'adelantada' });
  });
});

describe('planPrepayment — validaciones', () => {
  it('solo toca cuotas que vencen de hoy en adelante', () => {
    const base = [{ id: 'v', number: 1, amount: 500, due_date: '2026-11-01' }, ...cuotas([500])];
    const r = planPrepayment(base, 100, 'reducir_plazo', HOY);
    expect(r.changes!.map((c) => c.id)).toEqual(['i1']);
    expect(r.overdueSkipped).toBe(1);
  });
  it('rechaza montos inválidos o mayores a lo que falta', () => {
    const base = cuotas([500, 500]);
    expect(planPrepayment(base, 0, 'reducir_plazo', HOY).error).toMatch(/mayor a cero/);
    expect(planPrepayment(base, 1000.01, 'reducir_plazo', HOY).error).toMatch(/supera/);
    expect(planPrepayment([], 100, 'reducir_cuota', HOY).error).toMatch(/no hay cuotas futuras/i);
  });
  it('abonar todo deja todas las cuotas futuras adelantadas', () => {
    const base = cuotas([500, 500]);
    const r = planPrepayment(base, 1000, 'reducir_cuota', HOY);
    expect(r.changes!.every((c) => c.status === 'adelantada' && c.newAmount === 0)).toBe(true);
  });
});
