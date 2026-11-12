// Fechas y meses de la app de Administración. Formato fijo (no depende del
// idioma del navegador: la demo se pinta en el servidor y no debe desajustarse
// al hidratar). Todo en hora de Lima (UTC-5, sin horario de verano).

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-10-01T12:11:20+00:00" (o con -05:00) -> "01/10/2026 07:11" en Lima. */
export function fechaHoraLima(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms - 5 * 3_600_000);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "2026-10" -> "octubre de 2026". */
export function nombreMes(mes: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(mes);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return mes;
  return `${MESES[Number(m[2]) - 1]} de ${m[1]}`;
}

/** Mes (aaaa-mm) de hoy en Lima. */
export function mesActualLima(ahora: Date = new Date()): string {
  const d = new Date(ahora.getTime() - 5 * 3_600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** Suma o resta meses a un aaaa-mm. */
export function sumarMes(mes: string, delta: number): string {
  const [y, m] = mes.split("-").map(Number);
  const t = y * 12 + (m - 1) + delta;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}

/** Primer y último día del mes (aaaa-mm-dd). */
export function rangoMes(mes: string): { desde: string; hasta: string } {
  const [y, m] = mes.split("-").map(Number);
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { desde: `${mes}-01`, hasta: `${mes}-${pad(ultimo)}` };
}

/** Suma días a un aaaa-mm-dd. */
export function sumarDias(fecha: string, dias: number): string {
  const [y, m, d] = fecha.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + dias));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Meses (aaaa-mm) que toca un rango de fechas, de menor a mayor. */
export function mesesEntre(desde: string, hasta: string): string[] {
  const salida: string[] = [];
  for (let m = desde.slice(0, 7); m <= hasta.slice(0, 7) && salida.length < 36; m = sumarMes(m, 1)) salida.push(m);
  return salida;
}
