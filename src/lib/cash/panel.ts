import { RUBRO_ETIQUETAS, type Rubro } from './clasificar';

/** Ancho de una barra (0 a 100) respecto al mayor valor de su grupo. */
export function porcentajeBarra(valor: number, maximo: number): number {
  if (!(maximo > 0) || !(valor > 0)) return 0;
  return Math.max(2, Math.min(100, Math.round((valor / maximo) * 100)));
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** "2026-11" -> "nov 2026". */
export function etiquetaMes(mes: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(mes);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return mes;
  return `${MESES[Number(m[2]) - 1]} ${m[1]}`;
}

export function etiquetaRubro(rubro: string): string {
  if (rubro === 'sin_asignar') return 'Sin asignar';
  return RUBRO_ETIQUETAS[rubro as Rubro] ?? rubro;
}

/** Mes actual de Lima como AAAA-MM. */
export function mesActualLima(ahora = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit' })
    .format(ahora)
    .slice(0, 7);
}
