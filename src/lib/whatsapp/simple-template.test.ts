import { describe, expect, it } from 'vitest';

import { OPT_OUT_FOOTER, templateNameFromTitle, templateStatusText } from './simple-template';
import { isOptOutMessage } from './opt-out';

describe('templateNameFromTitle', () => {
  it('makes a valid Meta name from free text', () => {
    expect(templateNameFromTitle('Recordatorio Noviembre!')).toBe('recordatorio_noviembre');
    expect(templateNameFromTitle('  Promoción  Las Rocas 2026 ')).toBe('promocion_las_rocas_2026');
    expect(templateNameFromTitle('¡¡¡')).toBe('');
  });
});

describe('templateStatusText', () => {
  it('speaks plainly', () => {
    expect(templateStatusText('APPROVED').label).toBe('Aprobada');
    expect(templateStatusText('PENDING').label).toBe('En revisión');
    expect(templateStatusText('REJECTED').tone).toBe('bad');
    expect(templateStatusText(undefined).label).toBe('Desconocido');
  });
});

describe('OPT_OUT_FOOTER', () => {
  it('fits the 60-character footer limit and its keyword is an opt-out', () => {
    expect(OPT_OUT_FOOTER.length).toBeLessThanOrEqual(60);
    expect(isOptOutMessage('BAJA')).toBe(true);
  });
});
