// ============================================================
// Pantallas de planes para quien NO tiene acceso a cobranzas (084).
//
// Legal y cronograma leen el calendario (`installment_schedule`: número,
// monto, fecha y pendiente/cerrada) pero no la tabla `installments` ni los
// saldos. "Sin acceso" no es "no debe": esas pantallas no pueden afirmar
// "Al día" ni "S/ 0.00 por cobrar".
// ============================================================

import type { Installment } from "@/types";

/** Fila de la vista `installment_schedule` (sin columnas de pago). */
export interface FilaCalendario {
  id: string;
  plan_id: string;
  account_id: string;
  number: number;
  amount: number;
  due_date: string;
  state: "pendiente" | "cerrada";
}

/** `moduleAccess` null = 084 sin aplicar: no se oculta nada. */
export function sinAccesoCobranzas(
  moduleAccess: Record<string, boolean> | null | undefined,
): boolean {
  return moduleAccess?.cobranzas === false;
}

/** Parte una lista en tandas (para `.in()` con muchos ids). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/**
 * El calendario como `Installment` para reutilizar la lista del detalle.
 * Las cerradas (pagada, adelantada o condonada: el calendario no dice cuál)
 * quedan como "pagada" y la pantalla las rotula "Cerrada".
 */
export function calendarioACuotas(filas: readonly FilaCalendario[]): Installment[] {
  return filas.map((f) => ({
    id: f.id,
    plan_id: f.plan_id,
    account_id: f.account_id,
    number: f.number,
    amount: f.amount,
    due_date: f.due_date,
    status: f.state === "pendiente" ? "pendiente" : "pagada",
  })) as Installment[];
}

/**
 * Errores de "la tabla o vista todavía no existe" (084 sin aplicar): se
 * toleran en silencio. Cualquier otro error de lectura se le muestra al usuario.
 */
export function esFaltaDeObjeto(
  error: { code?: string } | null | undefined,
): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205" || error?.code === "PGRST202";
}
