// Conciliación del estado de cuenta con el libro de pagos del ERP (084).
// Pura y con pruebas. El estado de cuenta no trae código de cliente, así que
// solo se cruza por monto exacto y fecha (±2 días); si hay un solo candidato
// se concilia, si hay varios queda "revisar" para que lo decida una persona.

import type { EstadoMovimiento } from "./estado-cuenta";

export const VENTANA_DIAS = 2;

export interface MovimientoConciliable {
  id: string;
  /** Día en Lima (aaaa-mm-dd). */
  fecha: string;
  deposito: number;
  estado: EstadoMovimiento;
  paymentId: string | null;
}

export interface PagoErp {
  id: string;
  /** installment_payments.paid_on (aaaa-mm-dd). */
  paidOn: string;
  amount: number;
  voided: boolean;
}

export interface ResultadoConciliacion {
  movementId: string;
  estado: "conciliado" | "revisar" | "por_conciliar";
  paymentId: string | null;
  candidatos: string[];
}

const centavos = (n: number) => Math.round(n * 100);
const dia = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/** Días calendario de `a` a `b` (positivo si b es posterior). */
export function diasEntre(a: string, b: string): number {
  return Math.round((dia(b) - dia(a)) / 86_400_000);
}

/**
 * Para cada depósito pendiente (por conciliar o a revisar) busca pagos del
 * ERP con el mismo monto y fecha ±2 días, sin contar anulados ni pagos que ya
 * están enlazados a otro movimiento. Un pago que reclaman varios depósitos no
 * se asigna a ninguno: todos pasan a "revisar".
 */
export function conciliar(movs: readonly MovimientoConciliable[], pagos: readonly PagoErp[]): ResultadoConciliacion[] {
  const enlazados = new Set(movs.filter((m) => m.paymentId).map((m) => m.paymentId as string));
  const libres = pagos.filter((p) => !p.voided && !enlazados.has(p.id));
  const pendientes = movs.filter((m) => m.deposito > 0 && (m.estado === "por_conciliar" || m.estado === "revisar"));

  const candidatosDe = new Map<string, string[]>();
  const reclamos = new Map<string, number>();
  for (const m of pendientes) {
    const c = libres
      .filter((p) => centavos(p.amount) === centavos(m.deposito) && Math.abs(diasEntre(m.fecha, p.paidOn)) <= VENTANA_DIAS)
      .map((p) => p.id);
    candidatosDe.set(m.id, c);
    for (const id of c) reclamos.set(id, (reclamos.get(id) ?? 0) + 1);
  }

  return pendientes.map((m) => {
    const c = candidatosDe.get(m.id) ?? [];
    if (c.length === 0) return { movementId: m.id, estado: "por_conciliar", paymentId: null, candidatos: [] };
    if (c.length === 1 && reclamos.get(c[0]) === 1) return { movementId: m.id, estado: "conciliado", paymentId: c[0], candidatos: c };
    return { movementId: m.id, estado: "revisar", paymentId: null, candidatos: c };
  });
}

export interface PorValidar {
  /** Depósitos del banco que ninguna cuota del ERP respalda todavía. */
  depositosSinPago: MovimientoConciliable[];
  /** Pagos del ERP (no anulados) que no tienen un depósito enlazado. */
  pagosSinDeposito: PagoErp[];
  /** Depósitos por conciliar o a revisar. */
  faltaConciliar: number;
}

export function resumenPorValidar(movs: readonly MovimientoConciliable[], pagos: readonly PagoErp[]): PorValidar {
  const depositosSinPago = movs.filter((m) => m.deposito > 0 && (m.estado === "por_conciliar" || m.estado === "revisar"));
  const enlazados = new Set(movs.filter((m) => m.estado === "conciliado" && m.paymentId).map((m) => m.paymentId as string));
  return {
    depositosSinPago,
    pagosSinDeposito: pagos.filter((p) => !p.voided && !enlazados.has(p.id)),
    faltaConciliar: depositosSinPago.length,
  };
}
