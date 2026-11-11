"use client";

// Pantallas de la demostración de Cobranzas (/cobranzas/demo): las mismas
// piezas de la app (tarjeta vino, tramos, vista de tarjetas en celular y tabla
// en laptop) con datos inventados. No lee ni escribe nada.

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, Check, ClipboardList, FileText, HandCoins, MessageCircle } from "lucide-react";

import { GoldenBody, GoldenFrame, type SeccionApp } from "@/components/apps/golden-frame";
import { ResumenMoraCard } from "@/components/cobranzas/resumen-mora";
import { fechaLima, type Debtor, type Tramo } from "@/lib/collections";
import { dinero as formatCurrency } from "@/lib/cobranzas/dinero";
import {
  GESTIONES_DEMO,
  HOY_DEMO,
  morososDemo,
  PAGOS_DEL_DIA_DEMO,
  VOUCHERS_DEMO,
} from "@/lib/cobranzas/demo-datos";
import { resumenMora } from "@/lib/cobranzas/resumen";

const BASE = "/cobranzas/demo";

const SECCIONES_DEMO: readonly SeccionApp[] = [
  { href: BASE, etiqueta: "Morosos", largo: "Cuotas y morosos", icono: HandCoins, exacta: true, tambien: [`${BASE}/cliente/`] },
  { href: `${BASE}/vouchers`, etiqueta: "Vouchers", largo: "Vouchers por revisar", icono: FileText },
  { href: `${BASE}/gestiones`, etiqueta: "Gestiones", largo: "Gestiones", icono: ClipboardList },
  { href: `${BASE}/reporte`, etiqueta: "Del día", largo: "Reporte del día", icono: CalendarDays },
];

export function DemoCobranzasShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <GoldenBody app="cobranzas">
      <GoldenFrame
        nombre="Golden Cobranzas"
        subtitulo="GOLDEN · DREAM HABITAT"
        icono={HandCoins}
        secciones={SECCIONES_DEMO}
        pathname={pathname}
        rotuloDemo="Demostración · datos inventados"
      >
        {children}
      </GoldenFrame>
    </GoldenBody>
  );
}

const CLASE_TRAMO: Record<Tramo, string> = {
  "1-30": "gchip gchip-1-30",
  "31-60": "gchip gchip-31-60",
  "61-90": "gchip gchip-61-90",
  "90+": "gchip gchip-90",
};

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/** En la demo el botón no abre WhatsApp: los teléfonos son inventados. */
function BotonCobrar() {
  return (
    <button type="button" className="gbtn-wa" title="En la demostración no se envía nada">
      <MessageCircle size={15} /> Cobrar
    </button>
  );
}

export function MorososDemo() {
  const debtors = useMemo(() => morososDemo(), []);
  const resumen = useMemo(() => resumenMora(debtors), [debtors]);
  const [tramo, setTramo] = useState<Tramo | "todos">("todos");
  const visibles = debtors.filter((d) => tramo === "todos" || d.tramo === tramo);

  return (
    <div className="space-y-5">
      <ResumenMoraCard resumen={resumen} tramo={tramo} onTramo={setTramo} formatear={formatCurrency} />
      <p className="text-sm" style={{ color: "var(--ink-3)" }}>
        Clientes con cuotas vencidas al {fechaLima(HOY_DEMO)}, del atraso más antiguo al más reciente.
      </p>

      {/* Laptop: tabla */}
      <div className="gpanel hidden md:block">
        <table className="gtable">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Lote</th>
              <th style={{ textAlign: "right" }}>Vencido</th>
              <th>Atraso</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visibles.map((d) => (
              <tr key={`${d.contactId}-${d.currency}`}>
                <td>
                  <Link href={`${BASE}/cliente/${d.contactId}`} className="font-semibold hover:underline">
                    {d.name}
                  </Link>
                  <span className="block text-xs" style={{ color: "var(--ink-3)" }}>{d.phone}</span>
                </td>
                <td>
                  {d.units.join(", ")}
                  <span className="block text-xs" style={{ color: "var(--ink-3)" }}>{d.projects.join(", ")}</span>
                </td>
                <td style={{ textAlign: "right" }}>
                  <span className="font-semibold">{formatCurrency(d.overdueAmount, d.currency)}</span>
                  <span className="block text-xs" style={{ color: "var(--ink-3)" }}>{plural(d.overdueCount, "cuota", "cuotas")}</span>
                  {d.inReviewCount > 0 && (
                    <span className="block text-xs" style={{ color: "var(--info)" }}>
                      + {formatCurrency(d.inReviewAmount, d.currency)} con voucher en revisión
                    </span>
                  )}
                </td>
                <td>
                  <span className={CLASE_TRAMO[d.tramo]}>{d.daysLate} días</span>
                  <span className="block text-xs" style={{ color: "var(--ink-3)" }}>desde {fechaLima(d.oldestDue)}</span>
                </td>
                <td style={{ textAlign: "right" }}>
                  <BotonCobrar />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Celular: tarjetas */}
      <ul className="space-y-3 md:hidden">
        {visibles.map((d) => (
          <TarjetaMoroso key={`${d.contactId}-${d.currency}`} d={d} />
        ))}
      </ul>
    </div>
  );
}

function TarjetaMoroso({ d }: { d: Debtor }) {
  return (
    <li className="gitem">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`${BASE}/cliente/${d.contactId}`} className="block font-semibold">
            {d.name}
          </Link>
          <p className="text-xs" style={{ color: "var(--ink-3)" }}>
            Lote {d.units.join(", ")} · {d.projects.join(", ")}
          </p>
        </div>
        <span className={CLASE_TRAMO[d.tramo]}>{d.daysLate} días</span>
      </div>
      <p className="mt-2">
        <span className="text-lg font-semibold">{formatCurrency(d.overdueAmount, d.currency)}</span>
        <span className="text-xs" style={{ color: "var(--ink-3)" }}> · {plural(d.overdueCount, "cuota", "cuotas")}</span>
      </p>
      {d.inReviewCount > 0 && (
        <p className="text-xs" style={{ color: "var(--info)" }}>
          + {formatCurrency(d.inReviewAmount, d.currency)} con voucher en revisión
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <BotonCobrar />
        <Link
          href={`${BASE}/cliente/${d.contactId}`}
          className="inline-flex min-h-11 flex-1 items-center justify-center rounded-[10px] border text-sm font-semibold"
          style={{ borderColor: "var(--line-strong)", background: "var(--surface)" }}
        >
          Ver ficha
        </Link>
      </div>
    </li>
  );
}

export function VouchersDemo() {
  return (
    <div className="space-y-4">
      <p className="text-sm" style={{ color: "var(--ink-3)" }}>
        Vouchers que mandaron los clientes y esperan que alguien los apruebe o los rechace.
      </p>
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {VOUCHERS_DEMO.map((v) => (
          <li key={v.id} className="gitem">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{v.cliente}</p>
                <p className="text-xs" style={{ color: "var(--ink-3)" }}>Lote {v.lote} · cuota {v.cuota}</p>
              </div>
              <span className="gchip gchip-info">En revisión</span>
            </div>
            <p className="mt-2 text-lg font-semibold">{formatCurrency(v.monto, v.moneda)}</p>
            <p className="text-xs" style={{ color: "var(--ink-3)" }}>
              {v.metodo} · {v.referencia} · enviado {fechaLima(v.enviado)}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-[10px] text-sm font-semibold text-white md:min-h-9"
                style={{ background: "var(--guinda)" }}
                title="En la demostración no se aprueba nada"
              >
                <Check size={16} /> Aprobar
              </button>
              <button
                type="button"
                className="inline-flex min-h-11 flex-1 items-center justify-center rounded-[10px] border text-sm font-semibold md:min-h-9"
                style={{ borderColor: "var(--line-strong)", background: "var(--surface)" }}
              >
                Rechazar
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GestionesDemo() {
  return (
    <div className="space-y-4">
      <div className="gpanel hidden md:block">
        <table className="gtable">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Gestión</th>
              <th>Promesa</th>
              <th>Nota</th>
              <th>Fecha</th>
            </tr>
          </thead>
          <tbody>
            {GESTIONES_DEMO.map((g) => (
              <tr key={g.id}>
                <td className="font-semibold">{g.cliente}</td>
                <td>
                  {g.resultado}
                  <span className="block text-xs" style={{ color: "var(--ink-3)" }}>{g.canal}</span>
                </td>
                <td>
                  {g.promesa ? (
                    <>
                      {fechaLima(g.promesa)}
                      {g.monto ? <span className="block text-xs" style={{ color: "var(--ink-3)" }}>{formatCurrency(g.monto, "PEN")}</span> : null}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="text-xs" style={{ color: "var(--ink-2)" }}>{g.nota}</td>
                <td className="text-xs" style={{ color: "var(--ink-3)" }}>{fechaLima(g.fecha)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-3 md:hidden">
        {GESTIONES_DEMO.map((g) => (
          <li key={g.id} className="gitem">
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold">{g.cliente}</p>
              <span className="text-xs" style={{ color: "var(--ink-3)" }}>{fechaLima(g.fecha)}</span>
            </div>
            <p className="mt-1 text-sm">
              {g.resultado} · <span style={{ color: "var(--ink-3)" }}>{g.canal}</span>
            </p>
            {g.promesa && (
              <p className="text-sm">
                Promete {fechaLima(g.promesa)}
                {g.monto ? ` · ${formatCurrency(g.monto, "PEN")}` : ""}
              </p>
            )}
            <p className="mt-1 text-xs" style={{ color: "var(--ink-3)" }}>{g.nota}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DelDiaDemo() {
  const soles = PAGOS_DEL_DIA_DEMO.filter((p) => p.moneda === "PEN").reduce((n, p) => n + p.monto, 0);
  return (
    <div className="space-y-5">
      <section className="gcard-hero" aria-label="Cobrado en el día">
        <p className="gcard-hero-label">Cobrado el {fechaLima(HOY_DEMO)}</p>
        <p className="gcard-hero-value">{formatCurrency(soles, "PEN")}</p>
        <p className="gcard-hero-sub">{plural(PAGOS_DEL_DIA_DEMO.length, "pago registrado", "pagos registrados")}</p>
      </section>
      <div className="gpanel hidden md:block">
        <table className="gtable">
          <thead>
            <tr>
              <th>Hora</th>
              <th>Cliente</th>
              <th>Lote</th>
              <th>Método</th>
              <th style={{ textAlign: "right" }}>Monto</th>
            </tr>
          </thead>
          <tbody>
            {PAGOS_DEL_DIA_DEMO.map((p) => (
              <tr key={p.id}>
                <td>{p.hora}</td>
                <td className="font-semibold">{p.cliente}</td>
                <td>{p.lote} · cuota {p.cuota}</td>
                <td>{p.metodo}</td>
                <td style={{ textAlign: "right" }} className="font-semibold">{formatCurrency(p.monto, p.moneda)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-3 md:hidden">
        {PAGOS_DEL_DIA_DEMO.map((p) => (
          <li key={p.id} className="gitem flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold">{p.cliente}</p>
              <p className="text-xs" style={{ color: "var(--ink-3)" }}>
                {p.hora} · Lote {p.lote} · {p.metodo}
              </p>
            </div>
            <p className="shrink-0 font-semibold">{formatCurrency(p.monto, p.moneda)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FichaDemo({ contactId }: { contactId: string }) {
  const d = morososDemo().find((x) => x.contactId === contactId);
  if (!d) {
    return (
      <p className="py-12 text-center text-sm" style={{ color: "var(--ink-3)" }}>
        Este cliente no está en la demostración.{" "}
        <Link href={BASE} className="underline">Volver a los morosos</Link>
      </p>
    );
  }
  return (
    <div className="space-y-5">
      <Link href={BASE} className="text-sm font-semibold underline" style={{ color: "var(--guinda)" }}>
        ← Volver a los morosos
      </Link>
      <section className="gcard-hero">
        <p className="gcard-hero-label">{d.name}</p>
        <p className="gcard-hero-value">{formatCurrency(d.overdueAmount, d.currency)}</p>
        <p className="gcard-hero-sub">
          Lote {d.units.join(", ")} · {d.projects.join(", ")} · {d.daysLate} días de atraso ({plural(d.overdueCount, "cuota", "cuotas")})
        </p>
      </section>
      <div className="flex gap-2">
        <BotonCobrar />
        <span className={`${CLASE_TRAMO[d.tramo]} self-center`}>Tramo {d.tramo} días</span>
      </div>
      <p className="text-xs" style={{ color: "var(--ink-3)" }}>
        Teléfono de la demostración: {d.phone}
      </p>
    </div>
  );
}
