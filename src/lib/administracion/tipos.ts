// Formas que usan las pantallas de Administración (la app y su demostración).
// Los mapeos desde las filas de la base son puros y tienen pruebas.

import type { PagoErp } from "./conciliacion";
import type { EstadoMovimiento, TipoMovimiento } from "./estado-cuenta";

export interface MovimientoGuardado {
  id: string;
  fechaHora: string;
  /** Día en Lima (aaaa-mm-dd). */
  fecha: string;
  descripcion: string;
  tipo: TipoMovimiento;
  propio: boolean;
  deposito: number;
  retiro: number;
  saldo: number | null;
  agencia: string | null;
  estado: EstadoMovimiento;
  paymentId: string | null;
  nota: string | null;
}

export interface PagoVista extends PagoErp {
  moneda: string;
  cliente: string | null;
  lote: string | null;
  cuota: number | null;
  metodo: string | null;
}

/** Fila de bank_statement_movements tal como llega de PostgREST. */
export interface FilaMovimiento {
  id: string;
  fecha_hora: string;
  fecha: string;
  descripcion: string;
  tipo: string;
  propio: boolean;
  deposito: number | string;
  retiro: number | string;
  saldo: number | string | null;
  agencia: string | null;
  estado: string;
  payment_id: string | null;
  nota: string | null;
}

/** Fila de installment_payments con sus relaciones. */
export interface FilaPago {
  id: string;
  amount: number | string;
  paid_on: string;
  method: string | null;
  voided_at: string | null;
  installment: { number: number } | null;
  plan: { currency: string; contact: { name: string | null } | null; unit: { code: string } | null } | null;
}

export const SELECT_MOVIMIENTOS = "id, fecha_hora, fecha, descripcion, tipo, propio, deposito, retiro, saldo, agencia, estado, payment_id, nota";
export const SELECT_PAGOS =
  "id, amount, paid_on, method, voided_at, installment:installments(number), plan:payment_plans(currency, contact:contacts(name), unit:real_estate_units(code))";

const TIPOS = ["convenio", "interbancaria", "app", "efectivo", "comision", "otro"];
const ESTADOS = ["por_conciliar", "conciliado", "no_es_cuota", "revisar"];

export function aMovimiento(f: FilaMovimiento): MovimientoGuardado {
  return {
    id: f.id,
    fechaHora: f.fecha_hora,
    fecha: f.fecha,
    descripcion: f.descripcion,
    tipo: (TIPOS.includes(f.tipo) ? f.tipo : "otro") as TipoMovimiento,
    propio: Boolean(f.propio),
    deposito: Number(f.deposito) || 0,
    retiro: Number(f.retiro) || 0,
    saldo: f.saldo === null || f.saldo === undefined ? null : Number(f.saldo),
    agencia: f.agencia,
    estado: (ESTADOS.includes(f.estado) ? f.estado : "revisar") as EstadoMovimiento,
    paymentId: f.payment_id,
    nota: f.nota,
  };
}

export function aPago(f: FilaPago): PagoVista {
  return {
    id: f.id,
    paidOn: f.paid_on,
    amount: Number(f.amount) || 0,
    voided: f.voided_at !== null,
    moneda: f.plan?.currency ?? "PEN",
    cliente: f.plan?.contact?.name ?? null,
    lote: f.plan?.unit?.code ?? null,
    cuota: f.installment?.number ?? null,
    metodo: f.method,
  };
}
