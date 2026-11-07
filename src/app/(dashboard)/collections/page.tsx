"use client";

// ============================================================
// /collections — Cobranzas (ERP fase 1).
//
// La bandeja de morosos de la oficina: quién debe, cuánto, desde cuándo
// (tramos 1-30 / 31-60 / 61-90 / +90 días), en qué proyecto y manzana se
// concentra la deuda, y un WhatsApp listo para cobrar. Solo lee; la lógica
// vive en src/lib/collections.ts (con pruebas).
// ============================================================

import { useEffect, useMemo, useState } from "react";
import { Download, HandCoins, Loader2, MessageCircle } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";
import {
  TRAMOS,
  buildDebtors,
  debtorsCsv,
  groupByManzana,
  hoyLima,
  whatsappLink,
  type Debtor,
  type OverdueInstallment,
  type Tramo,
} from "@/lib/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ContactDetailView } from "@/components/contacts/contact-detail-view";

const PAGE = 1000;

const TRAMO_STYLE: Record<Tramo, string> = {
  "1-30": "bg-amber-500/10 text-amber-400",
  "31-60": "bg-orange-500/10 text-orange-400",
  "61-90": "bg-rose-500/10 text-rose-400",
  "90+": "bg-red-600/15 text-red-400",
};

const fecha = (iso: string | null) => {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};

export default function CollectionsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<OverdueInstallment[]>([]);
  const [reminders, setReminders] = useState<Map<string, string>>(new Map());
  const [tramo, setTramo] = useState<Tramo | "todos">("todos");
  const [proyecto, setProyecto] = useState<string>("todos");
  const [busqueda, setBusqueda] = useState("");
  const [abierto, setAbierto] = useState<string | null>(null);
  const today = useMemo(() => hoyLima(), []);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      setLoading(true);
      const all: OverdueInstallment[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error: err } = await supabase
          .from("installments")
          .select(
            "id, plan_id, number, amount, due_date, plan:payment_plans(id, currency, status, contact:contacts(id, name, phone, dni), unit:real_estate_units(code, manzana, project:real_estate_projects(name)))",
          )
          .eq("status", "pendiente")
          .lt("due_date", today)
          .order("due_date", { ascending: true })
          .range(from, from + PAGE - 1);
        if (err) {
          if (!cancelled) setError(err.message);
          break;
        }
        all.push(...((data ?? []) as unknown as OverdueInstallment[]));
        if (!data || data.length < PAGE) break;
      }

      // Último aviso automático de cada cuota vencida (migración 052).
      const last = new Map<string, string>();
      const ids = all.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 200) {
        const { data } = await supabase
          .from("installment_reminders")
          .select("installment_id, sent_at")
          .in("installment_id", ids.slice(i, i + 200));
        for (const r of (data ?? []) as { installment_id: string; sent_at: string }[]) {
          const prev = last.get(r.installment_id);
          if (!prev || r.sent_at > prev) last.set(r.installment_id, r.sent_at);
        }
      }
      if (cancelled) return;
      setRows(all);
      setReminders(last);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [today]);

  const debtors = useMemo(() => buildDebtors(rows, today, reminders), [rows, today, reminders]);
  const proyectos = useMemo(
    () => [...new Set(debtors.flatMap((d) => d.projects))].sort(),
    [debtors],
  );

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return debtors.filter((d) => {
      if (tramo !== "todos" && d.tramo !== tramo) return false;
      if (proyecto !== "todos" && !d.projects.includes(proyecto)) return false;
      if (!q) return true;
      return [d.name, d.phone, d.dni, ...d.units].filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
    });
  }, [debtors, tramo, proyecto, busqueda]);

  const filasProyecto = useMemo(
    () => (proyecto === "todos" ? rows : rows.filter((r) => r.plan?.unit?.project?.name === proyecto)),
    [rows, proyecto],
  );
  const manzanas = useMemo(() => groupByManzana(filasProyecto, today).slice(0, 8), [filasProyecto, today]);

  // Totales por moneda (no se mezclan soles y dólares).
  const totales = useMemo(() => {
    const m = new Map<string, { amount: number; debtors: number }>();
    for (const d of debtors) {
      const t = m.get(d.currency) ?? { amount: 0, debtors: 0 };
      t.amount += d.overdueAmount;
      t.debtors += 1;
      m.set(d.currency, t);
    }
    return [...m.entries()];
  }, [debtors]);

  const porTramo = useMemo(() => {
    const c: Record<Tramo, number> = { "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
    for (const d of debtors) c[d.tramo] += 1;
    return c;
  }, [debtors]);

  function exportar() {
    const blob = new Blob([`﻿${debtorsCsv(visibles)}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cobranzas-${today}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <HandCoins className="h-6 w-6 text-primary" /> Cobranzas
          </h1>
          <p className="text-sm text-muted-foreground">
            Clientes con cuotas vencidas al {fecha(today)}, del atraso más antiguo al más reciente.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={exportar} disabled={loading || visibles.length === 0}>
          <Download className="h-4 w-4" /> Exportar CSV
        </Button>
      </div>

      {error && <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm">No se pudo cargar: {error}</p>}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : debtors.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">No hay cuotas vencidas. Todos al día.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {totales.map(([cur, t]) => (
              <div key={cur} className="rounded-xl border border-border bg-card p-4">
                <p className="text-xs text-muted-foreground">Vencido ({cur})</p>
                <p className="text-xl font-semibold text-rose-400">{formatCurrency(t.amount, cur)}</p>
                <p className="text-xs text-muted-foreground">{t.debtors} cliente{t.debtors === 1 ? "" : "s"}</p>
              </div>
            ))}
            {TRAMOS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTramo(tramo === t ? "todos" : t)}
                className={cn(
                  "rounded-xl border p-4 text-left transition-colors",
                  tramo === t ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-muted",
                )}
              >
                <p className="text-xs text-muted-foreground">{t} días</p>
                <p className="text-xl font-semibold">{porTramo[t]}</p>
                <p className="text-xs text-muted-foreground">clientes</p>
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder="Buscar por nombre, teléfono, DNI o lote"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              className="sm:max-w-xs"
            />
            {proyectos.length > 1 && (
              <select
                value={proyecto}
                onChange={(e) => setProyecto(e.target.value)}
                className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                aria-label="Proyecto"
              >
                <option value="todos">Todos los proyectos</option>
                {proyectos.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
            <section>
              {/* Laptop: tabla */}
              <div className="hidden overflow-hidden rounded-xl border border-border md:block">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Cliente</th>
                      <th className="px-3 py-2 font-medium">Lotes</th>
                      <th className="px-3 py-2 text-right font-medium">Vencido</th>
                      <th className="px-3 py-2 font-medium">Atraso</th>
                      <th className="px-3 py-2 font-medium">Último aviso</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {visibles.map((d) => (
                      <tr key={`${d.contactId}-${d.currency}`} className="border-t border-border hover:bg-muted/30">
                        <td className="px-3 py-2">
                          <button type="button" className="text-left hover:underline" onClick={() => setAbierto(d.contactId)}>
                            <span className="font-medium">{d.name}</span>
                            <span className="block text-xs text-muted-foreground">{d.phone ?? "Sin teléfono"}</span>
                          </button>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {d.units.join(", ") || "—"}
                          <span className="block text-muted-foreground">{d.projects.join(", ")}</span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className="font-semibold">{formatCurrency(d.overdueAmount, d.currency)}</span>
                          <span className="block text-xs text-muted-foreground">{d.overdueCount} cuota{d.overdueCount === 1 ? "" : "s"}</span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={cn("rounded-full px-2 py-0.5 text-xs", TRAMO_STYLE[d.tramo])}>{d.daysLate} días</span>
                          <span className="block text-xs text-muted-foreground">desde {fecha(d.oldestDue)}</span>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{fecha(d.lastReminder)}</td>
                        <td className="px-3 py-2 text-right">
                          <CobrarButton d={d} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Celular: tarjetas */}
              <ul className="space-y-2 md:hidden">
                {visibles.map((d) => (
                  <li key={`${d.contactId}-${d.currency}`} className="rounded-xl border border-border bg-card p-3">
                    <div className="flex items-start justify-between gap-2">
                      <button type="button" className="text-left" onClick={() => setAbierto(d.contactId)}>
                        <p className="font-medium">{d.name}</p>
                        <p className="text-xs text-muted-foreground">{d.units.join(", ") || "—"} · {d.projects.join(", ")}</p>
                      </button>
                      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs", TRAMO_STYLE[d.tramo])}>{d.daysLate} días</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <p className="text-sm">
                        <span className="font-semibold">{formatCurrency(d.overdueAmount, d.currency)}</span>
                        <span className="text-xs text-muted-foreground"> · {d.overdueCount} cuota{d.overdueCount === 1 ? "" : "s"}</span>
                      </p>
                      <CobrarButton d={d} />
                    </div>
                  </li>
                ))}
              </ul>
              {visibles.length === 0 && (
                <p className="py-8 text-center text-sm text-muted-foreground">Nadie coincide con el filtro.</p>
              )}
            </section>

            <aside className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Dónde se concentra</h2>
              <ul className="space-y-1.5">
                {manzanas.map((g) => (
                  <li key={`${g.key}-${g.currency}`} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                    <span>
                      {g.key}
                      <span className="block text-xs text-muted-foreground">{g.debtors} cliente{g.debtors === 1 ? "" : "s"}</span>
                    </span>
                    <span className="font-medium">{formatCurrency(g.overdueAmount, g.currency)}</span>
                  </li>
                ))}
              </ul>
            </aside>
          </div>
        </>
      )}

      <ContactDetailView
        open={abierto !== null}
        onOpenChange={(o) => !o && setAbierto(null)}
        contactId={abierto}
        onUpdated={() => {}}
      />
    </div>
  );
}

function CobrarButton({ d }: { d: Debtor }) {
  const link = whatsappLink(d, formatCurrency(d.overdueAmount, d.currency));
  if (!link) return <span className="text-xs text-muted-foreground">Sin celular</span>;
  return (
    <a
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
    >
      <MessageCircle className="h-3.5 w-3.5" /> Cobrar
    </a>
  );
}
