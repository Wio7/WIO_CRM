/**
 * Replies that mean "stop messaging me". Matched against the WHOLE message,
 * never as a substring: "quiero dar de baja mi cita" or "el precio baja?"
 * must not remove someone from future broadcasts.
 */
const OPT_OUT_PHRASES = new Set([
  'baja',
  'dar de baja',
  'darme de baja',
  'stop',
  'no molestar',
  'no molesten',
  'no me escriban',
  'no quiero mensajes',
  'no quiero recibir mensajes',
]);

export function isOptOutMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return OPT_OUT_PHRASES.has(normalized);
}
