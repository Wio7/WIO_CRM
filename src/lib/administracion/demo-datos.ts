// Datos INVENTADOS de la demostración de Administración (/administracion/demo).
// Nada de esto es real: los movimientos imitan el formato del estado de cuenta
// de la Caja Ica y los clientes y montos son ficticios. Se arman con el mismo
// lector y la misma conciliación de la app, así la demo muestra lo que la app hace.

import { conciliar, type MovimientoConciliable } from "./conciliacion";
import { parsearFilas, type MovimientoBanco } from "./estado-cuenta";
import { ENCABEZADO_ESTADO, FILAS_ESTADO_INVENTADAS, type FilaCruda } from "./fixture-estado";
import type { MovimientoGuardado, PagoVista } from "./tipos";

export const MES_DEMO = "2026-10";

const MAS_FILAS: FilaCruda[] = [
  ["06/10/2026 10:02:10", "TRANS. INTER. INME. (CCE)", 520, 0, 13138.9, 13138.9, "Libertad"],
  ["06/10/2026 11:40:00", "Depósito conv. cobranza", 380.4, 0, 13519.3, 13519.3, "Parcona"],
  ["06/10/2026 11:40:00", "Cargo conv. cobranza", 0, -1.5, 13517.8, 13517.8, "Parcona"],
  ["07/10/2026 09:15:30", "CONVENIOS (ABONO AHO) APP MOVIL", 275, 0, 13792.8, 13792.8, "Miraflores"],
  ["07/10/2026 09:15:31", "CONVENIOS COM (CARGO AHO) APP MOVIL", 0, -1, 13791.8, 13791.8, "Miraflores"],
  ["08/10/2026 12:30:00", "Depósito efectivo", 450, 0, 14241.8, 14241.8, "Libertad"],
  ["09/10/2026 08:45:12", "TRANS. INTER. INME. (CCE)", 610, 0, 14851.8, 14851.8, "Libertad"],
  ["12/10/2026 10:20:00", "Depósito conv. cobranza", 390, 0, 15241.8, 15241.8, "Parcona"],
  ["12/10/2026 10:20:00", "Cargo conv. cobranza", 0, -1.5, 15240.3, 15240.3, "Parcona"],
  ["13/10/2026 17:05:44", "CONVENIOS (ABONO AHO) APP MOVIL", 410.75, 0, 15651.05, 15651.05, "Villa El Salvador"],
  ["13/10/2026 17:05:45", "CONVENIOS COM (CARGO AHO) APP MOVIL", 0, -1, 15650.05, 15650.05, "Villa El Salvador"],
  ["14/10/2026 09:00:00", "TRANS. INTER. INME. (CCE)", 520, 0, 16170.05, 16170.05, "Libertad"],
  ["20/10/2026 14:12:00", "Depósito CCAKAS", 280, 0, 16450.05, 16450.05, "Libertad"],
  ["22/10/2026 18:26:15", "TRANS. INTER. INME. (CCE)", 495.5, 0, 16945.55, 16945.55, "Libertad"],
];

const p = (id: string, paidOn: string, amount: number, cliente: string, lote: string, cuota: number, metodo: string, voided = false): PagoVista => ({
  id, paidOn, amount, voided, moneda: "PEN", cliente, lote, cuota, metodo,
});

/** Pagos que el ERP ya tiene registrados (libro de pagos), con clientes inventados. */
export const PAGOS_DEMO: PagoVista[] = [
  p("pd1", "2026-10-01", 300, "Rosa Villanueva Paredes", "A-12", 4, "Transferencia"),
  p("pd2", "2026-10-01", 450.5, "Marco Quispe Huamán", "B-03", 7, "Transferencia"),
  // Dos pagos de 400 en días seguidos y dos depósitos de 400: la app no elige, pide revisar.
  p("pd3", "2026-10-01", 400, "Lucía Barrientos Ñahui", "C-21", 2, "Convenio"),
  p("pd3b", "2026-10-02", 400, "Julio Cárdenas Rojas", "A-07", 9, "Convenio"),
  p("pd4", "2026-10-01", 250, "Elena Salazar Toledo", "D-15", 11, "App"),
  p("pd5", "2026-10-02", 350.25, "Hugo Mendoza Ayala", "B-18", 5, "App"),
  p("pd6", "2026-10-03", 600, "Carmen Ríos Valdivia", "C-04", 3, "Efectivo"),
  p("pd7", "2026-10-06", 520, "Pedro Aliaga Campos", "A-30", 6, "Transferencia"),
  p("pd8", "2026-10-14", 520, "Gabriela Soto Medina", "E-02", 8, "Transferencia"),
  p("pd9", "2026-10-09", 700, "Julio Cárdenas Rojas", "A-07", 10, "Depósito"),
  p("pd10", "2026-10-20", 850, "Rosa Villanueva Paredes", "A-12", 5, "Depósito"),
  p("pd11", "2026-10-05", 999, "Marco Quispe Huamán", "B-03", 8, "Transferencia", true),
];

export interface EstadoCuentaDemo {
  mes: string;
  movimientos: MovimientoGuardado[];
  pagos: PagoVista[];
}

export function estadoCuentaDemo(): EstadoCuentaDemo {
  const lectura = parsearFilas([[...ENCABEZADO_ESTADO], ...FILAS_ESTADO_INVENTADAS, ...MAS_FILAS], "Estado de Cuenta - demostracion.xls");
  if (!lectura.ok) throw new Error(lectura.error);
  const base: MovimientoGuardado[] = lectura.movimientos.map((m: MovimientoBanco, i) => ({
    id: `dm${i + 1}`,
    fechaHora: m.fechaHora,
    fecha: m.fecha,
    descripcion: m.descripcion,
    tipo: m.tipo,
    propio: m.propio,
    deposito: m.deposito,
    retiro: m.retiro,
    saldo: m.saldo,
    agencia: m.agencia,
    estado: m.estado,
    paymentId: null,
    nota: null,
  }));
  const ordenados = [...base].sort((a, b) => a.fechaHora.localeCompare(b.fechaHora));
  const entrada: MovimientoConciliable[] = ordenados.map((m) => ({ id: m.id, fecha: m.fecha, deposito: m.deposito, estado: m.estado, paymentId: null }));
  const resultado = new Map(conciliar(entrada, PAGOS_DEMO).map((r) => [r.movementId, r]));
  const movimientos = ordenados.map((m) => {
    const r = resultado.get(m.id);
    if (!r || r.estado === "por_conciliar") return m;
    return { ...m, estado: r.estado, paymentId: r.paymentId };
  });
  return { mes: MES_DEMO, movimientos, pagos: PAGOS_DEMO };
}
