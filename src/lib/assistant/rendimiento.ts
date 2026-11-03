// ============================================================
// Las cuentas del rendimiento del equipo: el periodo en hora de Lima, el
// índice de actividad y el ranking. Sin red ni base de datos, para probarlo
// solo.
//
// El mejor rendimiento se mide por ventas (decisión del dueño, 2026-10-30).
// El índice sólo dice cuánto se movió cada uno: es la misma fórmula de la
// pantalla Control (golden 3d/src/lib/control.js) y tiene que dar lo mismo.
// ============================================================

const LIMA = "America/Lima";
const OFFSET_LIMA = "-05:00"; // Perú no cambia de hora.
const MIN_EN_LINEA = 4;
const PESOS = { cita: 3, cumplida: 2, mensaje: 0.5 };
const DIA = /^\d{4}-\d{2}-\d{2}$/;

export type Periodo = "hoy" | "semana" | "mes";

export interface Rango {
  /** ISO en UTC: el comienzo del primer día, en Lima. */
  desde: string;
  /** ISO en UTC, sin incluir: el comienzo del día siguiente al último. */
  hasta: string;
  diaDesde: string;
  diaHasta: string;
}

const hoyEnLima = (ahora: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: LIMA, year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora);

/** Suma días a "AAAA-MM-DD", contando en UTC para que no lo mueva ninguna zona. */
function sumarDias(dia: string, dias: number): string {
  const d = new Date(`${dia}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

const inicio = (dia: string) => new Date(`${dia}T00:00:00${OFFSET_LIMA}`).toISOString();

function rango(diaDesde: string, diaHasta: string): Rango {
  return { desde: inicio(diaDesde), hasta: inicio(sumarDias(diaHasta, 1)), diaDesde, diaHasta };
}

export function rangoDePeriodo(
  args: { periodo?: Periodo; desde?: string; hasta?: string },
  ahora = new Date(),
): Rango {
  if (args.desde && DIA.test(args.desde)) {
    return rango(args.desde, args.hasta && DIA.test(args.hasta) ? args.hasta : args.desde);
  }
  const hoy = hoyEnLima(ahora);
  if (args.periodo === "hoy") return rango(hoy, hoy);
  if (args.periodo === "semana") {
    const diaDeLaSemana = new Date(`${hoy}T00:00:00.000Z`).getUTCDay();
    const lunes = sumarDias(hoy, -((diaDeLaSemana + 6) % 7));
    return rango(lunes, sumarDias(lunes, 6));
  }
  const primero = `${hoy.slice(0, 7)}-01`;
  const siguiente = sumarDias(primero, 32).slice(0, 7);
  return rango(primero, sumarDias(`${siguiente}-01`, -1));
}

export interface CitasDelPeriodo {
  total: number;
  cumplidas: number;
  canceladas: number;
}

/** El índice de cada uno, en el mismo orden: 100 para quien más hizo. */
export function indicesDeActividad(personas: { citas: CitasDelPeriodo; enviados: number }[]): number[] {
  const puntos = personas.map(
    (p) =>
      (p.citas.total - p.citas.canceladas) * PESOS.cita + p.citas.cumplidas * PESOS.cumplida + p.enviados * PESOS.mensaje,
  );
  const tope = Math.max(0, ...puntos);
  return puntos.map((n) => (tope ? Math.round((n / tope) * 100) : 0));
}

export interface VentasDeAlguien {
  cantidad: number;
  /** Suma de los precios, por moneda. */
  importes: Record<string, number>;
  /** Ventas que cuentan pero no tienen precio registrado. */
  sin_precio: number;
}

export const ventasEnCero = (): VentasDeAlguien => ({ cantidad: 0, importes: {}, sin_precio: 0 });

export function sumarVenta(v: VentasDeAlguien, venta: { importe: number | null; moneda: string }): void {
  v.cantidad += 1;
  if (venta.importe === null) {
    v.sin_precio += 1;
    return;
  }
  v.importes[venta.moneda] = (v.importes[venta.moneda] ?? 0) + venta.importe;
}

/** Quien vendió más va primero; empatan por importe en soles y luego por actividad. */
export function armarRanking<T extends { nombre: string; ventas: VentasDeAlguien; indice_actividad: number }>(
  personas: T[],
): (T & { puesto: number })[] {
  return [...personas]
    .sort(
      (a, b) =>
        b.ventas.cantidad - a.ventas.cantidad ||
        (b.ventas.importes.PEN ?? 0) - (a.ventas.importes.PEN ?? 0) ||
        b.indice_actividad - a.indice_actividad ||
        a.nombre.localeCompare(b.nombre),
    )
    .map((p, i) => ({ ...p, puesto: i + 1 }));
}

export function estaEnLinea(iso: string | null | undefined, ahora = new Date()): boolean {
  if (!iso) return false;
  return (ahora.getTime() - new Date(iso).getTime()) / 60_000 < MIN_EN_LINEA;
}

/** El equipo con su conexión de ahora y sus minutos de hoy; los conectados, primero. */
export function armarActivos(
  gente: { user_id: string; full_name?: string | null; email?: string | null; account_role?: string | null }[],
  presencia: { user_id: string; last_seen_at: string | null }[],
  uso: { user_id: string; minutos: number | null }[],
  ahora = new Date(),
) {
  const visto = new Map(presencia.map((p) => [p.user_id, p.last_seen_at]));
  const minutos = new Map(uso.map((u) => [u.user_id, Number(u.minutos) || 0]));
  return gente
    .filter((p) => p.account_role !== "viewer")
    .map((p) => {
      const ultima = visto.get(p.user_id) ?? null;
      return {
        nombre: p.full_name || p.email || "?",
        en_linea: estaEnLinea(ultima, ahora),
        ultima_conexion: ultima,
        minutos_hoy: minutos.get(p.user_id) ?? 0,
      };
    })
    .sort((a, b) => Number(b.en_linea) - Number(a.en_linea) || (b.ultima_conexion ?? "").localeCompare(a.ultima_conexion ?? ""));
}
