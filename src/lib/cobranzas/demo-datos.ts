// Datos inventados de la demostración de Cobranzas (/cobranzas/demo). Nada de
// esto es de un cliente real: nombres, lotes, teléfonos y montos son ficticios.
// Se arma con las mismas funciones del ERP (buildDebtors), así los tramos y los
// totales de la demo salen de la lógica de verdad. La fecha es fija para que la
// demo se vea igual cada día.

import { buildDebtors, type Debtor, type OverdueInstallment } from "@/lib/collections";

export const HOY_DEMO = "2026-11-11";

interface FilaDemo {
  id: string; // id del cliente
  nombre: string;
  telefono: string;
  lote: string;
  manzana: string;
  moneda?: string;
  /** Vencimientos de las cuotas atrasadas y su saldo. */
  cuotas: { vence: string; monto: number; voucher?: boolean }[];
}

const FILAS: FilaDemo[] = [
  { id: "d1", nombre: "Rosa Villanueva Paredes", telefono: "900000101", lote: "A-12", manzana: "A", cuotas: [{ vence: "2026-10-28", monto: 850 }] },
  { id: "d2", nombre: "Marco Quispe Huamán", telefono: "900000102", lote: "B-03", manzana: "B", cuotas: [{ vence: "2026-10-05", monto: 850 }, { vence: "2026-11-05", monto: 850 }] },
  { id: "d3", nombre: "Lucía Barrientos Ñahui", telefono: "900000103", lote: "C-21", manzana: "C", cuotas: [{ vence: "2026-09-12", monto: 1200 }, { vence: "2026-10-12", monto: 1200 }, { vence: "2026-11-02", monto: 1200 }] },
  { id: "d4", nombre: "Julio Cárdenas Rojas", telefono: "900000104", lote: "A-07", manzana: "A", cuotas: [{ vence: "2026-08-20", monto: 950 }, { vence: "2026-09-20", monto: 950 }, { vence: "2026-10-20", monto: 950 }] },
  { id: "d5", nombre: "Elena Salazar Toledo", telefono: "900000105", lote: "D-15", manzana: "D", cuotas: [{ vence: "2026-07-30", monto: 780 }, { vence: "2026-08-30", monto: 780 }, { vence: "2026-09-30", monto: 780 }, { vence: "2026-10-30", monto: 780 }] },
  { id: "d6", nombre: "Hugo Mendoza Ayala", telefono: "900000106", lote: "B-18", manzana: "B", cuotas: [{ vence: "2026-04-15", monto: 1100 }, { vence: "2026-05-15", monto: 1100 }, { vence: "2026-06-15", monto: 1100 }, { vence: "2026-07-15", monto: 1100 }] },
  { id: "d7", nombre: "Carmen Ríos Valdivia", telefono: "900000107", lote: "C-04", manzana: "C", cuotas: [{ vence: "2026-11-01", monto: 640 }] },
  { id: "d8", nombre: "Pedro Aliaga Campos", telefono: "900000108", lote: "A-30", manzana: "A", cuotas: [{ vence: "2026-10-02", monto: 900 }, { vence: "2026-11-02", monto: 900, voucher: true }] },
  { id: "d9", nombre: "Gabriela Soto Medina", telefono: "900000109", lote: "E-02", manzana: "E", moneda: "USD", cuotas: [{ vence: "2026-10-10", monto: 320 }, { vence: "2026-11-10", monto: 320 }] },
];

export function cuotasDemo(): OverdueInstallment[] {
  const out: OverdueInstallment[] = [];
  for (const f of FILAS) {
    f.cuotas.forEach((c, i) => {
      out.push({
        id: `${f.id}-${i + 1}`,
        plan_id: `plan-${f.id}`,
        number: i + 1,
        amount: c.monto,
        due_date: c.vence,
        voucher_path: c.voucher ? "demo/voucher" : null,
        plan: {
          id: `plan-${f.id}`,
          currency: f.moneda ?? "PEN",
          status: "activo",
          contact: { id: f.id, name: f.nombre, phone: f.telefono, dni: null },
          unit: { code: f.lote, manzana: f.manzana, project: { name: "Residencial Los Olivos" } },
        },
      });
    });
  }
  return out;
}

export function morososDemo(): Debtor[] {
  return buildDebtors(cuotasDemo(), HOY_DEMO);
}

export interface VoucherDemo {
  id: string;
  cliente: string;
  lote: string;
  cuota: number;
  monto: number;
  moneda: string;
  metodo: string;
  referencia: string;
  enviado: string;
}

export const VOUCHERS_DEMO: VoucherDemo[] = [
  { id: "v1", cliente: "Pedro Aliaga Campos", lote: "A-30", cuota: 2, monto: 900, moneda: "PEN", metodo: "Transferencia", referencia: "OP 004821", enviado: "2026-11-10" },
  { id: "v2", cliente: "Rosa Villanueva Paredes", lote: "A-12", cuota: 1, monto: 850, moneda: "PEN", metodo: "Yape", referencia: "Yape 7731", enviado: "2026-11-11" },
  { id: "v3", cliente: "Carmen Ríos Valdivia", lote: "C-04", cuota: 1, monto: 640, moneda: "PEN", metodo: "Depósito", referencia: "Dep. 118204", enviado: "2026-11-09" },
];

export interface GestionDemo {
  id: string;
  cliente: string;
  canal: string;
  resultado: string;
  promesa: string | null;
  monto: number | null;
  nota: string;
  fecha: string;
}

export const GESTIONES_DEMO: GestionDemo[] = [
  { id: "g1", cliente: "Lucía Barrientos Ñahui", canal: "WhatsApp", resultado: "Prometió pagar", promesa: "2026-11-14", monto: 2400, nota: "Cobra su sueldo el 13.", fecha: "2026-11-10" },
  { id: "g2", cliente: "Julio Cárdenas Rojas", canal: "Llamada", resultado: "No contestó", promesa: null, monto: null, nota: "Se intentó dos veces.", fecha: "2026-11-10" },
  { id: "g3", cliente: "Elena Salazar Toledo", canal: "WhatsApp", resultado: "Prometió pagar", promesa: "2026-11-07", monto: 1560, nota: "Dijo que depositaba el viernes.", fecha: "2026-11-05" },
  { id: "g4", cliente: "Hugo Mendoza Ayala", canal: "Visita", resultado: "Pidió refinanciar", promesa: null, monto: null, nota: "Pasa a revisión de legal si no responde.", fecha: "2026-11-03" },
];

export interface PagoDemo {
  id: string;
  cliente: string;
  lote: string;
  cuota: number;
  monto: number;
  moneda: string;
  metodo: string;
  hora: string;
}

export const PAGOS_DEL_DIA_DEMO: PagoDemo[] = [
  { id: "p1", cliente: "Andrea Lozano Paz", lote: "B-11", cuota: 5, monto: 850, moneda: "PEN", metodo: "Transferencia", hora: "09:12" },
  { id: "p2", cliente: "Ricardo Fuentes Gil", lote: "D-02", cuota: 3, monto: 1100, moneda: "PEN", metodo: "Yape", hora: "10:40" },
  { id: "p3", cliente: "Silvia Montoya Ruiz", lote: "C-17", cuota: 8, monto: 640, moneda: "PEN", metodo: "Depósito", hora: "11:25" },
  { id: "p4", cliente: "Tomás Herrera Luna", lote: "E-05", cuota: 2, monto: 320, moneda: "USD", metodo: "Transferencia", hora: "12:03" },
];
