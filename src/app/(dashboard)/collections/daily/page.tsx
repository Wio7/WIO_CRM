"use client";

// ============================================================
// /collections/daily — reporte diario de pagos.
//
// Lee el libro installment_payments (084) por fecha de pago: cuánto entró,
// por qué método, quién lo registró y qué se anuló. Se exporta a CSV. Solo
// lee; las sumas viven en src/lib/payments-report.ts (con pruebas).
// ============================================================

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CalendarDays, Download, Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/currency";
import { fechaLima, hoyLima } from "@/lib/collections";
import { paymentsCsv, summarizePayments, type PaymentReportRow } from "@/lib/payments-report";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface LedgerRow {
  id: string;
  amount: number | string;
  method: string | null;
  reference: string | null;
  paid_on: string;
  registered_by: string | null;
  voided_at: string | null;
  void_reason: string | null;
  installment: { number: number } | null;
  plan: {
    currency: string;
    contact: { name: string | null } | null;
    unit: { code: string } | null;
  } | null;
}

const PAGE = 1000;

export default function DailyPaymentsPage() {
  const { moduleAccess } = useAuth();
  const [desde, setDesde] = useState(() => hoyLima());
  const [hasta, setHasta] = useState(() => hoyLima());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [falta084, setFalta084] = useState(false);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!desde || !hasta || desde > hasta) return;
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      setLoading(true);
      const all: LedgerRow[] = [];
      let err: string | null = null;
      let sin084 = false;
      for (let from = 0; ; from += PAGE) {
        const { data, error: e } = await supabase
          .from("installment_payments")
          .select(
            "id, amount, method, reference, paid_on, registered_by, voided_at, void_reason, installment:installments(number), plan:payment_plans(currency, contact:contacts(name), unit:real_estate_units(code))",
          )
          .gte("paid_on", desde)
          .lte("paid_on", hasta)
          .order("paid_on", { ascending: true })
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (e) {
          // 42P01 / PGRST205: la tabla no existe = 084 sin aplicar.
          if (e.code === "42P01" || e.code === "PGRST205") sin084 = true;
          else err = e.message;
          break;
        }
        all.push(...((data ?? []) as unknown as LedgerRow[]));
        if (!data || data.length < PAGE) break;
      }
      const ids = [...new Set(all.map((r) => r.registered_by).filter((x): x is string => Boolean(x)))];
      const map = new Map<string, string>();
      for (let i = 0; i < ids.length; i += 100) {
        const { data: people } = await supabase
          .from("profiles")
          .select("user_id, full_name")
          .in("user_id", ids.slice(i, i + 100));
        for (const p of (people ?? []) as { user_id: string; full_name: string | null }[]) {
          if (p.full_name) map.set(p.user_id, p.full_name);
        }
      }
      if (cancelled) return;
      setFalta084(sin084);
      setError(err);
      setRows(all);
      setNames(map);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [desde, hasta]);

  const reportRows = useMemo<PaymentReportRow[]>(
    () =>
      rows.map((r) => ({
        amount: r.amount,
        method: r.method,
        registered_by: r.registered_by,
        voided_at: r.voided_at,
        currency: r.plan?.currency ?? "PEN",
        paid_on: r.paid_on,
        client: r.plan?.contact?.name ?? null,
        unit: r.plan?.unit?.code ?? null,
        installment: r.installment?.number ?? null,
        reference: r.reference,
        registered_by_name: r.registered_by ? names.get(r.registered_by) ?? null : null,
        void_reason: r.void_reason,
      })),
    [rows, names],
  );

  // Una resumen por moneda: no se mezclan soles y dólares.
  const resumenes = useMemo(() => {
    const monedas = [...new Set(reportRows.map((r) => r.currency))].sort();
    return monedas.map((cur) => ({
      cur,
      ...summarizePayments(reportRows.filter((r) => r.currency === cur)),
    }));
  }, [reportRows]);

  function exportar() {
    const blob = new Blob([`﻿${paymentsCsv(reportRows)}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pagos-${desde}${hasta !== desde ? `_${hasta}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (moduleAccess?.cobranzas === false) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        Sin acceso a Cobranzas. Pídele al dueño de la cuenta que te asigne el área.
      </p>
    );
  }

  const rangoValido = desde && hasta && desde <= hasta;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/collections" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3 w-3" /> Cobranzas
          </Link>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <CalendarDays className="h-6 w-6 text-primary" /> Reporte diario de pagos
          </h1>
          <p className="text-sm text-muted-foreground">
            Pagos registrados con fecha de pago del {fechaLima(desde)} al {fechaLima(hasta)}.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1 text-xs text-muted-foreground">
            Desde
            <Input type="date" max={hoyLima()} value={desde} onChange={(e) => setDesde(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Hasta
            <Input type="date" max={hoyLima()} value={hasta} onChange={(e) => setHasta(e.target.value)} />
          </label>
          <Button variant="outline" size="sm" onClick={exportar} disabled={loading || rows.length === 0}>
            <Download className="h-4 w-4" /> Exportar CSV
          </Button>
        </div>
      </div>

      {!rangoValido && <p className="text-sm text-amber-400">La fecha &quot;desde&quot; no puede ser posterior a &quot;hasta&quot;.</p>}
      {falta084 && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          Falta aplicar la migración 084 (pagos protegidos) en Supabase: el libro de pagos todavía no existe.
        </p>
      )}
      {error && <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm">No se pudo cargar: {error}</p>}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : falta084 || error || !rangoValido ? null : rows.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">No hay pagos en esas fechas.</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {resumenes.map((s) => (
              <div key={s.cur} className="rounded-xl border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground">Total cobrado ({s.cur})</p>
                <p className="text-xl font-semibold text-emerald-400">{formatCurrency(s.total, s.cur)}</p>
                <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                  {Object.entries(s.byMethod).map(([m, v]) => (
                    <li key={m} className="flex justify-between gap-2">
                      <span>{m}</span>
                      <span>{formatCurrency(v, s.cur)}</span>
                    </li>
                  ))}
                </ul>
                {s.voided > 0 && (
                  <p className="mt-2 text-xs text-rose-400">Anulado (no suma): {formatCurrency(s.voided, s.cur)}</p>
                )}
              </div>
            ))}
          </div>

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Fecha</th>
                  <th className="px-3 py-2 font-medium">Cliente</th>
                  <th className="px-3 py-2 font-medium">Lote · cuota</th>
                  <th className="px-3 py-2 text-right font-medium">Monto</th>
                  <th className="px-3 py-2 font-medium">Método</th>
                  <th className="px-3 py-2 font-medium">Registró</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const cur = r.plan?.currency ?? "PEN";
                  return (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-3 py-2">{fechaLima(r.paid_on)}</td>
                      <td className="px-3 py-2">{r.plan?.contact?.name ?? "—"}</td>
                      <td className="px-3 py-2 text-xs">
                        {r.plan?.unit?.code ?? "—"} · cuota {r.installment?.number ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span className={r.voided_at ? "text-muted-foreground line-through" : "font-semibold"}>
                          {formatCurrency(Number(r.amount), cur)}
                        </span>
                        {r.voided_at && (
                          <span className="block text-xs text-rose-400">Anulado: {r.void_reason}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {r.method ?? "—"}
                        {r.reference && <span className="block text-muted-foreground">Op. {r.reference}</span>}
                      </td>
                      <td className="px-3 py-2 text-xs">{r.registered_by ? names.get(r.registered_by) ?? "—" : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
