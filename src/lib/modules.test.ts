import { describe, expect, it } from 'vitest';

import {
  MODULES,
  MODULE_AREAS,
  MODULE_OPTIONS,
  RUBRO_TEMPLATES,
  SIMPLE_VIEW_MODULES,
  enableWithRequirements,
  isModuleDisabled,
  isModuleVisible,
  isSimpleAccount,
  matchingTemplate,
  moduleArea,
  withDependencies,
} from './modules';

describe('simple view', () => {
  it('keeps inbox, contacts and broadcasts on, everything else off', () => {
    for (const keep of ['/inbox', '/contacts', '/broadcasts', '/broadcasts/templates']) {
      expect(isModuleDisabled(keep, SIMPLE_VIEW_MODULES)).toBe(false);
    }
    for (const off of ['/pipelines', '/projects', '/dialer', '/flows', '/agents']) {
      expect(isModuleDisabled(off, SIMPLE_VIEW_MODULES)).toBe(true);
    }
  });

  it('never turns off the dashboard or settings', () => {
    expect(isModuleDisabled('/dashboard', SIMPLE_VIEW_MODULES)).toBe(false);
    expect(isModuleDisabled('/settings', SIMPLE_VIEW_MODULES)).toBe(false);
    expect(MODULE_OPTIONS.map((m) => m.href)).not.toContain('/dashboard');
  });

  it('an account without pipelines gets the simple home', () => {
    expect(isSimpleAccount(SIMPLE_VIEW_MODULES)).toBe(true);
    expect(isSimpleAccount([])).toBe(false);
    expect(isSimpleAccount(undefined)).toBe(false);
  });
});

describe('registro de módulos del ERP', () => {
  it('cada módulo tiene un área conocida y no se repite', () => {
    const hrefs = MODULES.map((m) => m.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const m of MODULES) {
      expect(MODULE_AREAS.map((a) => a.key)).toContain(m.area);
      expect(moduleArea(m.href)).toBe(m.area);
    }
    expect(moduleArea('/dashboard')).toBeNull();
  });

  it('apagar Proyectos apaga Separaciones', () => {
    expect(withDependencies(['/projects'])).toEqual(['/projects', '/reservations']);
  });

  it('encender Separaciones enciende Proyectos', () => {
    expect(enableWithRequirements(['/projects', '/reservations', '/coupons'], '/reservations')).toEqual(['/coupons']);
  });

  it('withDependencies descarta rutas desconocidas y deja el orden del registro', () => {
    expect(withDependencies(['/agents', '/nada', '/inbox'])).toEqual(['/inbox', '/agents']);
  });

  it('las plantillas por rubro son coherentes', () => {
    for (const t of RUBRO_TEMPLATES) {
      expect(withDependencies(t.disabled)).toEqual([...t.disabled]);
      expect(matchingTemplate(t.disabled)).toBe(t.key);
    }
    // Inmobiliaria tiene cuotas, separaciones y caja; la barbería no tiene separaciones.
    const inmo = RUBRO_TEMPLATES.find((t) => t.key === 'inmobiliaria')!.disabled;
    for (const on of ['/projects', '/reservations', '/payment-plans', '/caja']) {
      expect(inmo).not.toContain(on);
    }
    expect(RUBRO_TEMPLATES.find((t) => t.key === 'barberia')!.disabled).toContain('/reservations');
    // Solo las cuentas de campañas pasan al inicio simple.
    for (const t of RUBRO_TEMPLATES) {
      expect(isSimpleAccount(t.disabled)).toBe(t.key === 'campanas');
    }
  });

  it('una lista suelta no coincide con ninguna plantilla', () => {
    expect(matchingTemplate(['/coupons'])).toBeNull();
    expect(matchingTemplate([])).toBe('todo');
  });
});

describe('Cobranzas depende de Cuotas', () => {
  it('se apaga si Cuotas está apagado, aunque no esté en la lista', () => {
    expect(isModuleDisabled('/collections', ['/payment-plans'])).toBe(true);
    expect(isModuleDisabled('/collections', ['/coupons'])).toBe(false);
    expect(isModuleDisabled('/collections', [])).toBe(false);
  });
});

describe('rutas desconocidas en disabled_modules', () => {
  it('siguen bloqueadas aunque no estén en el registro', () => {
    expect(isModuleDisabled('/legacy', ['/legacy'])).toBe(true);
  });
});

describe('visibilidad por acceso de módulo (084)', () => {
  it('oculta Cobranzas a quien no tiene acceso', () => {
    expect(isModuleVisible('/collections', [], { cobranzas: false })).toBe(false);
    expect(isModuleVisible('/collections/x', [], { cobranzas: false })).toBe(false);
  });
  it('la muestra con acceso', () => {
    expect(isModuleVisible('/collections', [], { cobranzas: true })).toBe(true);
  });
  it('sin la migración 084 (null) no oculta nada', () => {
    expect(isModuleVisible('/collections', [], null)).toBe(true);
  });
  it('módulos sin llave de acceso no se ven afectados', () => {
    expect(isModuleVisible('/contacts', [], { cobranzas: false })).toBe(true);
  });
  it('sigue respetando los módulos apagados de la cuenta', () => {
    expect(isModuleVisible('/collections', ['/collections'], { cobranzas: true })).toBe(false);
  });
});
