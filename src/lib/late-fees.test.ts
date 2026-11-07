import { describe, expect, it } from 'vitest';

import { contractLateFee, lateFee, lateFeesByDebtor, settingsFromAccount, type LateFeeSettings } from './late-fees';
import type { OverdueInstallment } from './collections';

const fija: LateFeeSettings = { type: 'fija', value: 20, graceDays: 5, capDays: 0 };
const pct: LateFeeSettings = { type: 'porcentaje_mensual', value: 3, graceDays: 0, capDays: 0 };

describe('lateFee', () => {
  it('sin mora configurada no cobra nada', () => {
    expect(lateFee(500, 40, { type: 'ninguna', value: 10, graceDays: 0, capDays: 0 })).toBe(0);
  });
  it('dentro de los días de gracia no cobra', () => {
    expect(lateFee(500, 5, fija)).toBe(0);
    expect(lateFee(500, 6, fija)).toBe(20);
  });
  it('fija es una vez por cuota, sin importar los días', () => {
    expect(lateFee(500, 200, fija)).toBe(20);
  });
  it('porcentaje mensual es proporcional a los días, redondeado a céntimos', () => {
    // 500 × 3% × 45/30 = 22.50
    expect(lateFee(500, 45, pct)).toBe(22.5);
    // 333.33 × 3% × 10/30 = 3.3333 → 3.33
    expect(lateFee(333.33, 10, pct)).toBe(3.33);
  });
  it('valores inválidos no cobran', () => {
    expect(lateFee(500, 40, { type: 'fija', value: -5, graceDays: 0, capDays: 0 })).toBe(0);
    expect(lateFee(500, 0, pct)).toBe(0);
  });
});

const cuota = (id: string, contact: string, due: string, amount: number): OverdueInstallment => ({
  id, plan_id: 'p', number: 1, amount, due_date: due,
  plan: { id: 'p', currency: 'PEN', status: 'activo', contact: { id: contact, name: 'X', phone: null }, unit: null },
});

describe('lateFeesByDebtor', () => {
  it('suma la mora de cada cuota vencida por cliente y moneda, sin repetir cuotas', () => {
    const rows = [cuota('a', 'c1', '2026-10-01', 500), cuota('a', 'c1', '2026-10-01', 500), cuota('b', 'c1', '2026-11-01', 500), cuota('c', 'c2', '2026-11-06', 100)];
    const m = lateFeesByDebtor(rows, '2026-11-07', fija);
    // c1: a (37 días) 20 + b (6 días) 20 = 40; c2: 1 día, en gracia = 0
    expect(m.get('c1|PEN')).toBe(40);
    expect(m.get('c2|PEN') ?? 0).toBe(0);
  });
});

describe('settingsFromAccount', () => {
  it('lee la configuración de la cuenta y cae en "ninguna" si falta o es rara', () => {
    expect(settingsFromAccount({ late_fee_type: 'fija', late_fee_value: '15.5', late_fee_grace_days: 3 })).toEqual({ type: 'fija', value: 15.5, graceDays: 3, capDays: 0 });
    expect(settingsFromAccount({ late_fee_type: 'otra' }).type).toBe('ninguna');
    expect(settingsFromAccount(null).type).toBe('ninguna');
    expect(settingsFromAccount({ late_fee_type: 'porcentaje_mensual', late_fee_value: 2, late_fee_grace_days: -4 }).graceDays).toBe(0);
  });
});

describe('revisión EGM: mora y vouchers en revisión', () => {
  it('no cobra mora por una cuota cuyo voucher está en revisión', () => {
    const r = { ...cuota('v', 'c9', '2026-10-01', 500), voucher_path: 'docs/v.jpg' };
    expect(lateFeesByDebtor([r], '2026-11-07', fija).get('c9|PEN') ?? 0).toBe(0);
  });
});

const diaria: LateFeeSettings = { type: 'diaria', value: 6, graceDays: 1, capDays: 60 };

describe('contractLateFee (diaria por contrato)', () => {
  it('cobra valor × días después de la gracia', () => {
    expect(contractLateFee('2026-10-01', '2026-11-07', diaria)).toBe(6 * 36);
  });
  it('aplica el tope de días cobrados', () => {
    expect(contractLateFee('2026-08-09', '2026-11-07', diaria)).toBe(360);
  });
  it('dentro de gracia o sin fecha no cobra', () => {
    expect(contractLateFee('2026-11-06', '2026-11-07', diaria)).toBe(0);
    expect(contractLateFee(null, '2026-11-07', diaria)).toBe(0);
  });
  it('sin tope (capDays 0) cobra todos los días', () => {
    expect(contractLateFee('2026-08-09', '2026-11-07', { ...diaria, capDays: 0 })).toBe(6 * 89);
  });
  it('otros tipos devuelven 0', () => {
    expect(contractLateFee('2026-10-01', '2026-11-07', fija)).toBe(0);
  });
});

describe('lateFeesByDebtor con diaria', () => {
  it('cobra una vez por contrato según la cuota más antigua, no por cuota', () => {
    const rows = [cuota('a', 'c1', '2026-10-01', 500), cuota('b', 'c1', '2026-11-01', 500)];
    expect(lateFeesByDebtor(rows, '2026-11-07', diaria).get('c1|PEN')).toBe(216);
  });
  it('suma contratos distintos del mismo cliente', () => {
    const base = cuota('z', 'c1', '2026-10-01', 500);
    const otro = { ...base, plan_id: 'p2', plan: { ...base.plan!, id: 'p2' } };
    const rows = [cuota('a', 'c1', '2026-10-01', 500), otro];
    expect(lateFeesByDebtor(rows, '2026-11-07', diaria).get('c1|PEN')).toBe(432);
  });
  it('settingsFromAccount acepta diaria y late_fee_cap_days', () => {
    expect(settingsFromAccount({ late_fee_type: 'diaria', late_fee_value: 6, late_fee_grace_days: 1, late_fee_cap_days: 60 })).toEqual(diaria);
  });
});
