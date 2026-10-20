import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { cashWorkbook } from './xlsx';

describe('cash Excel export', () => {
  it('creates both sheets and escapes untrusted concepts', () => {
    const bytes = cashWorkbook([{ id: '1', kind: 'expense', amount_cents: 1050, concept: '<varilla & fierro>', counterparty: 'Proveedor', occurred_on: '2026-01-01', budget_id: null, reversal_of: null, reversed: false, actor_name: 'Ana', created_at: '2026-01-01T10:00:00Z' }], []);
    const files = unzipSync(bytes);
    expect(strFromU8(files['xl/workbook.xml'])).toContain('Historial de cambios');
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('&lt;varilla &amp; fierro&gt;');
    expect(sheet).toContain('<v>10.5</v>');
  });
});
