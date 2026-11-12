// Lector del estado de cuenta de la Caja Ica (.xls de la banca por internet):
// filas crudas -> movimientos clasificados, con huella y resumen. Puro y con
// pruebas; leer el archivo en sí (SheetJS) vive en leer-xls.ts.
//
// Formato visto (octubre 2026): columnas `Fecha Hora` (dd/mm/aaaa hh:mm:ss,
// hora de Lima, como texto), `Descripción Operación`, `Depósitos`, `Retiros`
// (negativo), `Saldo Contable`, `Saldo Disponible`, `Agencia`. NO trae código
// de cliente. Las comisiones las paga la empresa (salen como retiros chicos).

export type TipoMovimiento = "convenio" | "interbancaria" | "app" | "efectivo" | "comision" | "otro";
export type EstadoMovimiento = "por_conciliar" | "conciliado" | "no_es_cuota" | "revisar";

export const TIPOS: readonly TipoMovimiento[] = ["convenio", "interbancaria", "app", "efectivo", "comision", "otro"];

export const ETIQUETA_TIPO: Record<TipoMovimiento, string> = {
  convenio: "Convenio",
  interbancaria: "Interbancaria",
  app: "App",
  efectivo: "Efectivo",
  comision: "Comisión",
  otro: "Otro",
};

export interface MovimientoBanco {
  /** ISO con la hora de Lima (UTC-5, sin horario de verano): 2026-10-01T07:11:20-05:00. */
  fechaHora: string;
  /** Día en Lima (aaaa-mm-dd). */
  fecha: string;
  descripcion: string;
  tipo: TipoMovimiento;
  /** Traspaso entre cuentas propias: entra a la caja pero no es un abono de cliente. */
  propio: boolean;
  deposito: number;
  /** Siempre positivo (el archivo lo trae en negativo). */
  retiro: number;
  saldo: number | null;
  agencia: string | null;
  /** Identifica el movimiento para no duplicarlo al volver a subir el archivo. */
  huella: string;
  estado: EstadoMovimiento;
}

export interface FilaResumen {
  n: number;
  /** Depósitos del tipo (en `comision`, la suma de los retiros). */
  monto: number;
}

export interface Resumen {
  totalDepositos: number;
  /** Depósitos que no son traspaso entre cuentas propias (lo que se cobró). */
  abonos: number;
  porTipo: Record<TipoMovimiento, FilaResumen>;
  /** Cargos que paga la empresa (movimientos de tipo comisión). */
  comisiones: FilaResumen;
}

export type ResultadoLectura =
  | {
      ok: true;
      cuenta: string | null;
      periodo: { desde: string; hasta: string } | null;
      movimientos: MovimientoBanco[];
      resumen: Resumen;
    }
  | { ok: false; error: string };

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const aCentavos = (n: number) => Math.round(n * 100);
const deCentavos = (c: number) => c / 100;

export function clasificarMovimiento(
  descripcion: string,
  deposito: number,
  retiro: number,
): { tipo: TipoMovimiento; propio: boolean } {
  const d = norm(descripcion);
  const propio = /terceros ahorros - cc propios/.test(d);
  if (Math.abs(retiro) > 0 && !(deposito > 0)) {
    // Cargos por convenio, por la app, por traspasos y el ITF: los paga la empresa.
    if (/^(cargo conv|convenios com|ccprop-cargo|cobro (de )?itf|com |comision)/.test(d)) return { tipo: "comision", propio };
    return { tipo: "otro", propio };
  }
  if (/^deposito conv\.? cobranza/.test(d)) return { tipo: "convenio", propio };
  if (/^trans(f|ferencia)?\.? inter/.test(d)) return { tipo: "interbancaria", propio };
  if (/^convenios \(abono aho\)/.test(d)) return { tipo: "app", propio };
  if (/^deposito efectivo/.test(d)) return { tipo: "efectivo", propio };
  return { tipo: "otro", propio };
}

function numero(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v).replace(/\s/g, "").replace(/,/g, "");
  if (t === "" || t === "-") return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** dd/mm/aaaa hh:mm:ss (texto) o número de serie de Excel -> { iso, fecha }. */
function leerFecha(v: unknown): { iso: string; fecha: string } | null {
  let y: number, mo: number, d: number, h = 0, mi = 0, s = 0;
  if (typeof v === "number" && Number.isFinite(v) && v > 20000) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const dt = new Date(ms);
    y = dt.getUTCFullYear(); mo = dt.getUTCMonth() + 1; d = dt.getUTCDate();
    h = dt.getUTCHours(); mi = dt.getUTCMinutes(); s = dt.getUTCSeconds();
  } else if (typeof v === "string") {
    const m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m) return null;
    d = Number(m[1]); mo = Number(m[2]); y = Number(m[3]);
    h = Number(m[4] ?? 0); mi = Number(m[5] ?? 0); s = Number(m[6] ?? 0);
  } else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  // Fecha inexistente (31/02): Date la desplaza de mes.
  if (new Date(Date.UTC(y, mo - 1, d)).getUTCMonth() !== mo - 1) return null;
  const fecha = `${y}-${pad(mo)}-${pad(d)}`;
  return { iso: `${fecha}T${pad(h)}:${pad(mi)}:${pad(s)}-05:00`, fecha };
}

const COLUMNAS = {
  fecha: "fecha hora",
  descripcion: "descripcion operacion",
  deposito: "depositos",
  retiro: "retiros",
  saldo: "saldo contable",
  agencia: "agencia",
} as const;

function vacia(fila: readonly unknown[]): boolean {
  return fila.every((c) => c === null || c === undefined || String(c).trim() === "");
}

export function resumirMovimientos(
  movs: readonly { tipo: TipoMovimiento; deposito: number; retiro: number; propio?: boolean }[],
): Resumen {
  const cent: Record<TipoMovimiento, { n: number; c: number }> = {
    convenio: { n: 0, c: 0 }, interbancaria: { n: 0, c: 0 }, app: { n: 0, c: 0 },
    efectivo: { n: 0, c: 0 }, comision: { n: 0, c: 0 }, otro: { n: 0, c: 0 },
  };
  let total = 0;
  let propio = 0;
  for (const m of movs) {
    if (m.tipo === "comision") {
      cent.comision.n++;
      cent.comision.c += aCentavos(m.retiro);
      continue;
    }
    const dep = aCentavos(m.deposito);
    if (dep <= 0) continue; // salidas de fondos: no son abonos
    cent[m.tipo].n++;
    cent[m.tipo].c += dep;
    total += dep;
    if (m.propio) propio += dep;
  }
  const f = (t: TipoMovimiento): FilaResumen => ({ n: cent[t].n, monto: deCentavos(cent[t].c) });
  return {
    totalDepositos: deCentavos(total),
    abonos: deCentavos(total - propio),
    porTipo: { convenio: f("convenio"), interbancaria: f("interbancaria"), app: f("app"), efectivo: f("efectivo"), comision: f("comision"), otro: f("otro") },
    comisiones: f("comision"),
  };
}

/** Número de cuenta (10+ dígitos) que trae el nombre del archivo, si lo trae. */
export function cuentaDeArchivo(archivo?: string | null): string | null {
  const m = (archivo ?? "").match(/(\d{10,})/);
  return m ? m[1] : null;
}

export function parsearFilas(filas: readonly (readonly unknown[])[], archivo?: string | null): ResultadoLectura {
  if (filas.length === 0 || filas.every((f) => vacia(f))) return { ok: false, error: "El archivo está vacío." };

  const iEnc = filas.findIndex((f) => {
    const celdas = f.map((c) => norm(String(c ?? "")));
    return celdas.includes(COLUMNAS.fecha) && celdas.includes(COLUMNAS.descripcion) && celdas.includes(COLUMNAS.deposito) && celdas.includes(COLUMNAS.retiro);
  });
  if (iEnc < 0) {
    return { ok: false, error: "No parece un estado de cuenta de la Caja Ica: faltan las columnas Fecha Hora, Descripción Operación, Depósitos y Retiros." };
  }
  const cab = filas[iEnc].map((c) => norm(String(c ?? "")));
  const col = (n: string) => cab.indexOf(n);
  const iF = col(COLUMNAS.fecha), iD = col(COLUMNAS.descripcion), iDep = col(COLUMNAS.deposito), iRet = col(COLUMNAS.retiro);
  const iSal = col(COLUMNAS.saldo), iAg = col(COLUMNAS.agencia);

  const vistas = new Map<string, number>();
  const movimientos: MovimientoBanco[] = [];
  for (let i = iEnc + 1; i < filas.length; i++) {
    const fila = filas[i];
    if (vacia(fila)) continue;
    const nFila = i + 1;
    const fecha = leerFecha(fila[iF]);
    if (!fecha) return { ok: false, error: `Fila ${nFila}: la fecha «${String(fila[iF] ?? "")}» no tiene el formato dd/mm/aaaa hh:mm:ss.` };
    const descripcion = String(fila[iD] ?? "").trim();
    if (!descripcion) return { ok: false, error: `Fila ${nFila}: falta la descripción de la operación.` };
    const dep = numero(fila[iDep]);
    const ret = numero(fila[iRet]);
    const sal = iSal >= 0 ? numero(fila[iSal]) : null;
    if (dep === null || ret === null) return { ok: false, error: `Fila ${nFila}: el depósito o el retiro no es un número.` };
    const deposito = Math.abs(dep);
    const retiro = Math.abs(ret);
    const { tipo, propio } = clasificarMovimiento(descripcion, deposito, retiro);
    const agencia = iAg >= 0 && fila[iAg] != null && String(fila[iAg]).trim() !== "" ? String(fila[iAg]).trim() : null;
    const base = [fecha.iso, descripcion, deposito.toFixed(2), retiro.toFixed(2), sal === null ? "" : sal.toFixed(2), agencia ?? ""].join("|");
    const n = (vistas.get(base) ?? 0) + 1;
    vistas.set(base, n);
    const noEsCuota = deposito <= 0 || propio || tipo === "comision" || /^capitalizacion intereses/.test(norm(descripcion));
    movimientos.push({
      fechaHora: fecha.iso,
      fecha: fecha.fecha,
      descripcion,
      tipo,
      propio,
      deposito,
      retiro,
      saldo: sal,
      agencia,
      huella: `${base}#${n}`,
      estado: noEsCuota ? "no_es_cuota" : "por_conciliar",
    });
  }
  if (movimientos.length === 0) return { ok: false, error: "El estado de cuenta no trae movimientos." };

  const fechas = movimientos.map((m) => m.fecha).sort();
  return {
    ok: true,
    cuenta: cuentaDeArchivo(archivo),
    periodo: { desde: fechas[0], hasta: fechas[fechas.length - 1] },
    movimientos,
    resumen: resumirMovimientos(movimientos),
  };
}
