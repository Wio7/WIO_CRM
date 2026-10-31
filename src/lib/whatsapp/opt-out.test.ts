import { describe, expect, it } from 'vitest';

import { isOptOutMessage } from './opt-out';

describe('isOptOutMessage', () => {
  it.each(['BAJA', ' baja. ', 'Baja!', 'STOP', 'Darme de baja', 'NO MOLESTAR', 'no me escriban'])(
    'accepts %s',
    (text) => {
      expect(isOptOutMessage(text)).toBe(true);
    },
  );

  it.each([
    'quiero dar de baja mi cita',
    'el precio baja?',
    'no pares, stop motion',
    'hola',
    '',
    null,
    undefined,
  ])('ignores %s', (text) => {
    expect(isOptOutMessage(text)).toBe(false);
  });
});
