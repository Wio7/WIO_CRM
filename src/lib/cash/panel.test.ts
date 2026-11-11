import { describe, expect, it } from 'vitest';
import { etiquetaMes, etiquetaRubro, mesActualLima, porcentajeBarra } from './panel';

describe('ayudas del panel de gerencia', () => {
  it('porcentaje de barra', () => {
    expect(porcentajeBarra(50, 100)).toBe(50);
    expect(porcentajeBarra(100, 100)).toBe(100);
    expect(porcentajeBarra(0, 100)).toBe(0);
    expect(porcentajeBarra(1, 1000)).toBe(2);
    expect(porcentajeBarra(5, 0)).toBe(0);
  });
  it('etiquetas', () => {
    expect(etiquetaMes('2026-11')).toBe('nov 2026');
    expect(etiquetaMes('mal')).toBe('mal');
    expect(etiquetaRubro('combi')).toBe('Combi');
    expect(etiquetaRubro('sin_asignar')).toBe('Sin asignar');
  });
  it('mes actual de Lima', () => {
    expect(mesActualLima(new Date('2026-12-01T03:00:00Z'))).toBe('2026-11');
    expect(mesActualLima(new Date('2026-12-01T06:00:00Z'))).toBe('2026-12');
  });
});
