"use client";

// Tarjeta vino de la pantalla de Morosos (estilo de la tarjeta de la Caja):
// total vencido y subtarjetas con los clientes en mora y cada tramo, que a la
// vez sirven de filtro. La usan la app (/cobranzas) y la demo.

import { TRAMOS, type Tramo } from "@/lib/collections";
import { formatCurrency } from "@/lib/currency";
import type { ResumenMora } from "@/lib/cobranzas/resumen";

interface Props {
  resumen: ResumenMora;
  tramo: Tramo | "todos";
  onTramo: (t: Tramo | "todos") => void;
  /** Mora estimada por moneda (solo si la cuenta cobra mora). */
  moraPorMoneda?: Record<string, number>;
}

export function ResumenMoraCard({ resumen, tramo, onTramo, moraPorMoneda = {} }: Props) {
  const [principal, ...otras] = resumen.porMoneda;
  const clientes = resumen.porMoneda.reduce((n, m) => n + m.clientes, 0);
  const mora = principal ? moraPorMoneda[principal.currency] ?? 0 : 0;

  return (
    <section className="gcard-hero" aria-label="Resumen de la mora">
      <p className="gcard-hero-label">Total vencido{principal ? ` (${principal.currency})` : ""}</p>
      <p className="gcard-hero-value">{principal ? formatCurrency(principal.monto, principal.currency) : "—"}</p>
      <p className="gcard-hero-sub">
        {principal ? `${principal.clientes} cliente${principal.clientes === 1 ? "" : "s"}` : "Nadie con cuotas vencidas"}
        {mora > 0 && principal ? ` · mora estimada ${formatCurrency(mora, principal.currency)}` : ""}
        {otras.map((m) => ` · ${formatCurrency(m.monto, m.currency)} (${m.currency}, ${m.clientes})`).join("")}
      </p>
      <div className="gcard-hero-grid">
        <button type="button" className="gcard-mini" aria-pressed={tramo === "todos"} onClick={() => onTramo("todos")}>
          <span className="gcard-mini-label">Clientes en mora</span>
          <span className="gcard-mini-value block">{clientes}</span>
        </button>
        {TRAMOS.map((t) => (
          <button
            key={t}
            type="button"
            className="gcard-mini"
            aria-pressed={tramo === t}
            onClick={() => onTramo(tramo === t ? "todos" : t)}
          >
            <span className="gcard-mini-label">{t} días</span>
            <span className="gcard-mini-value block">{resumen.porTramo[t].clientes}</span>
            <span className="gcard-mini-label block">{formatCurrency(resumen.porTramo[t].monto, principal?.currency ?? "PEN")}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
