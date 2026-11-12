// Filas INVENTADAS que imitan el formato exacto del estado de cuenta de la
// Caja Ica (mismas columnas, mismos textos de descripción, fechas
// dd/mm/aaaa hh:mm:ss como texto, retiros en negativo). Sirven para las
// pruebas del lector y para la demostración: no son datos reales.

export const ENCABEZADO_ESTADO = [
  "Fecha Hora",
  "Descripción Operación",
  "Depósitos",
  "Retiros",
  "Saldo Contable",
  "Saldo Disponible",
  "Agencia",
] as const;

export type FilaCruda = (string | number | null)[];

/** Un mes corto: 2 convenios, 2 interbancarias, 2 app, 1 efectivo, 1 CCAKAS, 1 cobranza propia, 1 traspaso propio, intereses, y una salida de 1,000. */
export const FILAS_ESTADO_INVENTADAS: FilaCruda[] = [
  ["01/10/2026 07:11:20", "TRANS. INTER. INME. (CCE)", 300, 0, 10300, 10300, "Libertad"],
  ["01/10/2026 07:25:53", "TRANS. INTER. INME. (CCE)", 450.5, 0, 10750.5, 10750.5, "Libertad"],
  ["01/10/2026 09:10:09", "Depósito conv. cobranza", 400, 0, 11150.5, 11150.5, "Parcona"],
  ["01/10/2026 09:10:09", "Cargo conv. cobranza", 0, -1.5, 11149, 11149, "Parcona"],
  ["01/10/2026 09:22:32", "CONVENIOS (ABONO AHO) APP MOVIL", 250, 0, 11399, 11399, "Villa El Salvador"],
  ["01/10/2026 09:22:33", "CONVENIOS COM (CARGO AHO) APP MOVIL", 0, -1, 11398, 11398, "Villa El Salvador"],
  ["01/10/2026 09:34:53", "Depósito CCAKAS", 310, 0, 11708, 11708, "Libertad"],
  ["02/10/2026 10:26:21", "CONVENIOS (ABONO AHO) APP MOVIL", 350.25, 0, 12058.25, 12058.25, "Miraflores"],
  ["02/10/2026 10:26:22", "CONVENIOS COM (CARGO AHO) APP MOVIL", 0, -1, 12057.25, 12057.25, "Miraflores"],
  ["02/10/2026 11:00:00", "Depósito conv. cobranza", 400, 0, 12457.25, 12457.25, "Parcona"],
  ["02/10/2026 11:00:00", "Cargo conv. cobranza", 0, -1.5, 12455.75, 12455.75, "Parcona"],
  ["03/10/2026 12:00:00", "Depósito efectivo", 600, 0, 13055.75, 13055.75, "Libertad"],
  ["03/10/2026 15:20:10", "Ccprop-depósito conv cobranza", 200, 0, 13255.75, 13255.75, "Ica"],
  ["03/10/2026 15:20:10", "Ccprop-cargo conv cobranza", 0, -1, 13254.75, 13254.75, "Ica"],
  ["04/10/2026 16:00:00", "DEPOSITO TERCEROS AHORROS - CC PROPIOS", 370, 0, 13624.75, 13624.75, "Ica"],
  ["05/10/2026 22:58:29", "TRANSF INTERB INMED ORD CCE HB", 0, -1000, 12624.75, 12624.75, "Ica"],
  ["05/10/2026 22:58:29", "COM TRANSF INTERB INMED ORD CCE HB", 0, -5.8, 12618.95, 12618.95, "Ica"],
  ["05/10/2026 23:00:00", "Cobro de ITF cargo cuenta", 0, -0.05, 12618.9, 12618.9, "Ica"],
  ["31/10/2026 23:59:58", "Capitalización intereses activa", 6.38, 0, 12625.28, 12625.28, "Ica"],
];

/** Depósitos de la muestra inventada: conv 2 / 800, interb 2 / 750.50, app 2 / 600.25, efectivo 1 / 600, otros 4 (CCAKAS, cobranza propia, traspaso propio, intereses). */
export const TOTALES_FIXTURE = {
  filas: 19,
  totalDepositos: 3637.13,
  abonos: 3267.13,
  convenio: { n: 2, monto: 800 },
  interbancaria: { n: 2, monto: 750.5 },
  app: { n: 2, monto: 600.25 },
  efectivo: { n: 1, monto: 600 },
  comisiones: { n: 7, monto: 11.85 },
} as const;
