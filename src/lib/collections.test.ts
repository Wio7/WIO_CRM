import { describe, expect, it } from 'vitest';

import {
  buildDebtors,
  daysBetween,
  debtorsCsv,
  fechaLima,
  hiddenOverdue,
  groupByManzana,
  hoyLima,
  inResolution,
  tramoDe,
  whatsappLink,
  type OverdueInstallment,
} from './collections';

const cuota = (over: Partial<OverdueInstallment> & { contact?: string; unit?: string; mz?: string; status?: string; currency?: string }): OverdueInstallment => ({
  id: over.id ?? Math.random().toString(36),
  plan_id: 'p1',
  number: 1,
  amount: over.amount ?? 500,
  due_date: over.due_date ?? '2026-10-05',
  plan: {
    id: 'p1',
    currency: over.currency ?? 'PEN',
    status: over.status ?? 'activo',
    contact: { id: over.contact ?? 'c1', name: 'Juan Pérez', phone: '987654321', dni: '12345678' },
    unit: { code: over.unit ?? 'A-12', manzana: over.mz ?? 'A', project: { name: 'Colinas 1' } },
  },
});

const HOY = '2026-11-07';

describe('días y tramos', () => {
  it('cuenta días de atraso', () => {
    expect(daysBetween('2026-11-06', HOY)).toBe(1);
    expect(daysBetween('2026-10-05', HOY)).toBe(33);
  });
  it('clasifica en tramos', () => {
    expect(tramoDe(1)).toBe('1-30');
    expect(tramoDe(30)).toBe('1-30');
    expect(tramoDe(31)).toBe('31-60');
    expect(tramoDe(90)).toBe('61-90');
    expect(tramoDe(91)).toBe('90+');
  });
  it('hoy en Lima usa la zona de Lima', () => {
    expect(hoyLima(new Date('2026-11-08T03:00:00Z'))).toBe('2026-11-07');
  });
});

describe('buildDebtors', () => {
  it('agrupa por cliente, suma, toma la cuota más antigua y ordena por atraso', () => {
    const out = buildDebtors(
      [
        cuota({ id: 'i1', due_date: '2026-10-05' }),
        cuota({ id: 'i2', due_date: '2026-11-05', unit: 'A-13' }),
        cuota({ id: 'i3', contact: 'c2', due_date: '2026-11-01', amount: '900.5' }),
        cuota({ id: 'i4', due_date: '2026-11-07' }), // vence hoy: no es atraso
        cuota({ id: 'i5', contact: 'c3', status: 'cancelado' }),
      ],
      HOY,
      new Map([['i2', '2026-11-08T14:00:00Z'], ['i1', '2026-10-08T14:00:00Z']]),
    );
    expect(out.map((d) => d.contactId)).toEqual(['c1', 'c2']);
    expect(out[0]).toMatchObject({
      overdueCount: 2, overdueAmount: 1000, oldestDue: '2026-10-05', daysLate: 33,
      tramo: '31-60', units: ['A-12', 'A-13'], projects: ['Colinas 1'], lastReminder: '2026-11-08T14:00:00Z',
    });
    expect(out[1].overdueAmount).toBe(900.5);
  });

  it('separa monedas del mismo cliente', () => {
    const out = buildDebtors([cuota({ id: 'a' }), cuota({ id: 'b', currency: 'USD' })], HOY);
    expect(out.map((d) => d.currency).sort()).toEqual(['PEN', 'USD']);
  });
});

describe('groupByManzana', () => {
  it('suma deuda y clientes por proyecto y manzana', () => {
    const g = groupByManzana(
      [cuota({ id: 'a' }), cuota({ id: 'b' }), cuota({ id: 'c', contact: 'c2', mz: 'B', amount: 2000 })],
      HOY,
    );
    expect(g[0]).toMatchObject({ key: 'Colinas 1 · Mz B', debtors: 1, overdueAmount: 2000 });
    expect(g[1]).toMatchObject({ key: 'Colinas 1 · Mz A', debtors: 1, overdueAmount: 1000 });
  });
});

describe('whatsapp y csv', () => {
  it('arma el enlace con +51 para celulares de 9 dígitos', () => {
    const [d] = buildDebtors([cuota({})], HOY);
    const url = whatsappLink(d, 'S/ 500')!;
    expect(url.startsWith('https://wa.me/51987654321?text=')).toBe(true);
    expect(decodeURIComponent(url.split('text=')[1])).toContain('Hola Juan');
    expect(whatsappLink({ ...d, phone: '123' }, 'x')).toBeNull();
  });
  it('genera CSV con punto y coma y escapa comillas', () => {
    const [d] = buildDebtors([cuota({})], HOY);
    const csv = debtorsCsv([{ ...d, name: 'Ana "La" Ruiz' }]);
    expect(csv.split('\n')[0]).toContain('Cliente;DNI;Teléfono');
    expect(csv).toContain('"Ana ""La"" Ruiz"');
  });
});

describe('correcciones de la revisión', () => {
  it('no cuenta dos veces una cuota repetida por la paginación', () => {
    const a = cuota({ id: 'dup', amount: 500 });
    const [d] = buildDebtors([a, { ...a }], HOY);
    expect(d.overdueCount).toBe(1);
    expect(d.overdueAmount).toBe(500);
    const [g] = groupByManzana([a, { ...a }], HOY);
    expect(g.overdueAmount).toBe(500);
  });

  it('cuenta las cuotas vencidas cuyo cliente no se ve', () => {
    const oculto: OverdueInstallment = { ...cuota({ id: 'h1', amount: 300 }), plan: { ...cuota({}).plan!, contact: null } };
    expect(hiddenOverdue([oculto, cuota({ id: 'v' })], HOY)).toEqual({ count: 1, amount: 300 });
  });

  it('solo pone +51 a celulares (9 dígitos que empiezan con 9)', () => {
    const [d] = buildDebtors([cuota({})], HOY);
    expect(whatsappLink({ ...d, phone: '056123456' }, 'x')).toBeNull();
    expect(whatsappLink({ ...d, phone: '+51 987 654 321' }, 'x')!.startsWith('https://wa.me/51987654321')).toBe(true);
  });

  it('muestra las fechas con hora en día de Lima', () => {
    expect(fechaLima('2026-11-08T02:00:00Z')).toBe('07/11/2026');
    expect(fechaLima('2026-11-05')).toBe('05/11/2026');
    expect(fechaLima(null)).toBe('—');
  });

  it('el CSV usa el día de Lima para el último aviso', () => {
    const [d] = buildDebtors([cuota({})], HOY);
    expect(debtorsCsv([{ ...d, lastReminder: '2026-11-08T02:00:00Z' }])).toContain(';07/11/2026');
  });
});

describe('revisión EGM: vouchers en revisión, CSV y teléfonos', () => {
  const conVoucher = (id: string, due: string, amount = 500): OverdueInstallment => ({ ...cuota({ id, due_date: due, amount }), voucher_path: 'docs/v.jpg' });

  it('una cuota con voucher en revisión no cuenta como deuda vencida, va aparte', () => {
    const [d] = buildDebtors([cuota({ id: 'a', due_date: '2026-10-05' }), conVoucher('b', '2026-09-05', 300)], HOY);
    expect(d.overdueCount).toBe(1);
    expect(d.overdueAmount).toBe(500);
    expect(d.inReviewCount).toBe(1);
    expect(d.inReviewAmount).toBe(300);
    // el atraso se mide desde la cuota que de verdad se debe
    expect(d.oldestDue).toBe('2026-10-05');
  });

  it('un cliente con todo en revisión queda al final y sin deuda vencida', () => {
    const out = buildDebtors([conVoucher('x', '2026-08-05'), cuota({ id: 'y', contact: 'c2', due_date: '2026-11-01' })], HOY);
    expect(out.map((d) => d.contactId)).toEqual(['c2', 'c1']);
    expect(out[1]).toMatchObject({ overdueCount: 0, overdueAmount: 0, inReviewCount: 1 });
  });

  it('la deuda por manzana no cuenta cuotas en revisión', () => {
    const g = groupByManzana([cuota({ id: 'a' }), conVoucher('b', '2026-10-05')], HOY);
    expect(g[0].overdueAmount).toBe(500);
  });

  it('el CSV neutraliza fórmulas en textos que vienen de afuera', () => {
    const [d] = buildDebtors([cuota({})], HOY);
    const csv = debtorsCsv([{ ...d, name: '=HYPERLINK("x")', phone: '+51987654321' }]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(";'+51987654321;");
  });

  it('acepta números con prefijo 00', () => {
    const [d] = buildDebtors([cuota({})], HOY);
    expect(whatsappLink({ ...d, phone: '0051987654321' }, 'x')!.startsWith('https://wa.me/51987654321')).toBe(true);
  });
});

describe('saldo por cuota (remaining)', () => {
  it('usa remaining en lugar de amount si viene', () => {
    const c = { ...cuota({ id: 'r1', amount: 500 }), remaining: 200 };
    expect(buildDebtors([c], HOY)[0].overdueAmount).toBe(200);
    expect(groupByManzana([c], HOY)[0].overdueAmount).toBe(200);
    const oculta = { ...cuota({ id: 'r2', amount: 500 }), remaining: '150', plan: { ...cuota({}).plan!, contact: null } };
    expect(hiddenOverdue([oculta], HOY).amount).toBe(150);
  });
});

describe('inResolution (causal de resolución, por contrato)', () => {
  const s = { installments: 2, days: 60 };
  const en = (id: string, plan: string, due: string, extra: Partial<OverdueInstallment> = {}): OverdueInstallment => {
    const base = cuota({ id, due_date: due });
    return { ...base, plan_id: plan, plan: { ...base.plan!, id: plan }, ...extra };
  };
  const debtor = (rows: OverdueInstallment[]) => buildDebtors(rows, HOY)[0];
  it('dos contratos con una cuota vencida cada uno (30 días) no es causal', () => {
    expect(inResolution(debtor([en('a', 'p1', '2026-10-08'), en('b', 'p2', '2026-10-08')]), s)).toBe(false);
  });
  it('un contrato con 2 cuotas vencidas es causal', () => {
    expect(inResolution(debtor([en('a', 'p1', '2026-10-08'), en('b', 'p1', '2026-11-01')]), s)).toBe(true);
  });
  it('por días en un solo contrato', () => {
    expect(inResolution(debtor([en('a', 'p1', '2026-09-06')]), s)).toBe(true);
  });
  it('solo vouchers en revisión no es causal', () => {
    const d = debtor([en('a', 'p1', '2026-08-01', { voucher_path: 'x.jpg' })]);
    expect(d.worstPlan).toBeNull();
    expect(inResolution(d, s)).toBe(false);
  });
  it('sin configurar nunca', () => {
    expect(inResolution(debtor([en('a', 'p1', '2026-01-01'), en('b', 'p1', '2026-02-01')]), { installments: 0, days: 0 })).toBe(false);
  });
});
