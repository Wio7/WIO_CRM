// Reporte diario de pagos (libro installment_payments, migración 084).
// Puro: recibe filas ya leídas. Los anulados no suman al total (son pagos
// que dejaron de valer) pero se informan aparte. Cuentas en centavos enteros
// para que la suma no arrastre errores de coma flotante. Una moneda por
// llamada: quien llama agrupa antes (no se mezclan soles y dólares).

import { csvCell } from "./collections";

export interface PaymentReportRow {
  amount: number | string;
  method: string | null;
  registered_by: string | null;
  voided_at: string | null;
  currency: string;
  // Solo para el CSV.
  paid_on?: string | null;
  client?: string | null;
  unit?: string | null;
  installment?: number | null;
  reference?: string | null;
  registered_by_name?: string | null;
  void_reason?: string | null;
}

export const SIN_METODO = "Sin método";

const toCents = (v: number | string) => Math.round((Number(v) || 0) * 100);

export function summarizePayments(rows: readonly PaymentReportRow[]): {
  byMethod: Record<string, number>;
  total: number;
  voided: number;
} {
  const byMethod: Record<string, number> = {};
  let total = 0;
  let voided = 0;
  for (const r of rows) {
    const c = toCents(r.amount);
    if (r.voided_at) {
      voided += c;
      continue;
    }
    total += c;
    const key = r.method?.trim() || SIN_METODO;
    byMethod[key] = (byMethod[key] ?? 0) + c;
  }
  for (const k of Object.keys(byMethod)) byMethod[k] /= 100;
  return { byMethod, total: total / 100, voided: voided / 100 };
}

/** CSV (separado por punto y coma, para Excel en español). */
export function paymentsCsv(rows: readonly PaymentReportRow[]): string {
  const head = [
    "Fecha de pago", "Cliente", "Lote", "Cuota", "Monto", "Moneda", "Método",
    "Operación", "Registró", "Estado", "Motivo de anulación",
  ];
  const lines = rows.map((r) =>
    [
      r.paid_on, r.client, r.unit, r.installment, (toCents(r.amount) / 100).toFixed(2), r.currency,
      r.method, r.reference, r.registered_by_name ?? r.registered_by, r.voided_at ? "Anulado" : "Vigente",
      r.void_reason,
    ]
      .map(csvCell)
      .join(";"),
  );
  return [head.join(";"), ...lines].join("\n");
}
