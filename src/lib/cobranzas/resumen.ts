// Resumen de la mora para la tarjeta vino de la pantalla de Morosos y la demo:
// vencido por moneda (soles y dólares no se mezclan) y clientes / monto por tramo.
// Puro y con pruebas. Quien solo espera la aprobación de su voucher no cuenta como mora.

import { TRAMOS, type Debtor, type Tramo } from "@/lib/collections";

export interface TotalMoneda {
  currency: string;
  monto: number;
  clientes: number;
}

export interface TotalTramo {
  /** Clientes del tramo, en cualquier moneda. */
  clientes: number;
  /** Monto del tramo en la moneda principal (no se mezclan monedas). */
  monto: number;
}

export interface ResumenMora {
  /** Una fila por moneda, la de más clientes primero. */
  porMoneda: TotalMoneda[];
  monedaPrincipal: string | null;
  porTramo: Record<Tramo, TotalTramo>;
}

const centavos = (n: number) => Math.round(n * 100) / 100;

export function resumenMora(debtors: readonly Debtor[]): ResumenMora {
  const enMora = debtors.filter((d) => d.overdueCount > 0);
  const monedas = new Map<string, TotalMoneda>();
  for (const d of enMora) {
    const m = monedas.get(d.currency) ?? { currency: d.currency, monto: 0, clientes: 0 };
    m.monto += d.overdueAmount;
    m.clientes += 1;
    monedas.set(d.currency, m);
  }
  const porMoneda = [...monedas.values()]
    .sort((a, b) => b.clientes - a.clientes || a.currency.localeCompare(b.currency))
    .map((m) => ({ ...m, monto: centavos(m.monto) }));
  const monedaPrincipal = porMoneda[0]?.currency ?? null;

  const porTramo = Object.fromEntries(TRAMOS.map((t) => [t, { clientes: 0, monto: 0 }])) as Record<Tramo, TotalTramo>;
  for (const d of enMora) {
    porTramo[d.tramo].clientes += 1;
    if (d.currency === monedaPrincipal) porTramo[d.tramo].monto += d.overdueAmount;
  }
  for (const t of TRAMOS) porTramo[t].monto = centavos(porTramo[t].monto);
  return { porMoneda, monedaPrincipal, porTramo };
}
