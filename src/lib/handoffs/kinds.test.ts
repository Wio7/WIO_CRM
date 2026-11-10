import { describe, expect, it } from 'vitest';

import { HANDOFF_KINDS, TOPIC_LABELS, kindsFrom, kindsTo } from './kinds';

describe('kindsFrom', () => {
  it('cobranzas puede pasar a legal o enviar a postventa', () => {
    expect(kindsFrom('cobranzas')).toEqual(['pase_legal', 'postventa_desde_cobranzas']);
  });
  it('legal solo envía a postventa', () => {
    expect(kindsFrom('legal')).toEqual(['postventa_desde_legal']);
  });
  it('postventa no envía a nadie', () => {
    expect(kindsFrom('postventa')).toEqual([]);
  });
});

describe('kindsTo', () => {
  it('cobranzas no recibe nada (en F1)', () => {
    expect(kindsTo('cobranzas')).toEqual([]);
  });
  it('legal recibe el pase de cobranzas', () => {
    expect(kindsTo('legal')).toEqual(['pase_legal']);
  });
  it('postventa recibe de cobranzas y de legal', () => {
    expect(kindsTo('postventa')).toEqual(['postventa_desde_cobranzas', 'postventa_desde_legal']);
  });
});

describe('HANDOFF_KINDS y TOPIC_LABELS', () => {
  it('botones y entidades', () => {
    expect(HANDOFF_KINDS.pase_legal).toMatchObject({ from: 'cobranzas', to: 'legal', button: 'Pasar a legal', entityType: 'payment_plan' });
    expect(HANDOFF_KINDS.postventa_desde_cobranzas).toMatchObject({ from: 'cobranzas', to: 'postventa', button: 'Enviar a postventa', entityType: 'contact' });
    expect(HANDOFF_KINDS.postventa_desde_legal).toMatchObject({ from: 'legal', to: 'postventa', button: 'Enviar a postventa', entityType: 'contact' });
  });
  it('etiquetas de tema', () => {
    expect(TOPIC_LABELS).toEqual({
      ubicacion: 'Ubicación',
      avance_obra: 'Avance de obra',
      entrega: 'Entrega',
      documentos: 'Documentos',
      otro: 'Otro',
    });
  });
});
