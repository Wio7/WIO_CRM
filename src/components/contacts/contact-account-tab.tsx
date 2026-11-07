"use client";

// Pestaña "Cuenta" de la ficha del contacto: sus separaciones y sus planes
// de cuotas con lo pagado, el saldo, lo vencido y la próxima fecha. Solo
// lee (RLS de cada tabla decide qué ve cada usuario). Núcleo del ERP:
// un solo registro del cliente, de la separación a la última cuota.

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/currency";
import {
  planHealth,
  summarizeClientAccount,
  type PlanBalanceRow,
} from "@/lib/client-account";

interface ReservationRow {
  id: string;
  status: string;
  total_amount: number | string;
  currency: string;
  created_at: string;
  units: { unit: { code: string } | null }[] | null;
}

interface PlanRow {
  id: string;
  created_at: string;
  installments_count: number;
  monthly_amount: number | string;
  unit: { code: string } | null;
}

const RESERVATION_LABEL: Record<string, string> = {
  pendiente: "Pendiente",
  aprobada: "Aprobada",
  rechazada: "Rechazada",
  cerrada: "Cerrada",
};

const HEALTH: Record<ReturnType<typeof planHealth>, { label: string; className: string }> = {
  "al-dia": { label: "Al día", className: "bg-emerald-500/10 text-emerald-400" },
  "con-atraso": { label: "Con atraso", className: "bg-rose-500/10 text-rose-400" },
  pagado: { label: "Pagado", className: "bg-primary/10 text-primary" },
  otro: { label: "Suspendido", className: "bg-muted text-muted-foreground" },
};

function fecha(iso: string | null) {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

export function ContactAccountTab({ contactId }: { contactId: string }) {
  const [loading, setLoading] = useState(true);
  const [reservations, setReservations] = useState<ReservationRow[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [balances, setBalances] = useState<PlanBalanceRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      setLoading(true);
      const [res, pl, bal] = await Promise.all([
        supabase
          .from("reservations")
          .select("id, status, total_amount, currency, created_at, units:reservation_units(unit:real_estate_units(code))")
          .eq("contact_id", contactId)
          .order("created_at", { ascending: false }),
        supabase
          .from("payment_plans")
          .select("id, created_at, installments_count, monthly_amount, unit:real_estate_units(code)")
          .eq("contact_id", contactId)
          .order("created_at", { ascending: false }),
        supabase.from("payment_plan_balances").select("*").eq("contact_id", contactId),
      ]);
      if (cancelled) return;
      setReservations((res.data ?? []) as unknown as ReservationRow[]);
      setPlans((pl.data ?? []) as unknown as PlanRow[]);
      setBalances((bal.data ?? []) as PlanBalanceRow[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (reservations.length === 0 && plans.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Este contacto no tiene separaciones ni cuotas.
      </p>
    );
  }

  const totals = summarizeClientAccount(balances);
  const balanceById = new Map(balances.map((b) => [b.plan_id, b]));

  return (
    <div className="space-y-5">
      {totals.map((t) => (
        <div key={t.currency} className="grid grid-cols-2 gap-2">
          <Stat label="Total" value={formatCurrency(t.total, t.currency)} />
          <Stat label="Pagado" value={formatCurrency(t.paid, t.currency)} />
          <Stat label="Saldo" value={formatCurrency(t.pending, t.currency)} />
          <Stat
            label={t.overdueCount ? `Vencido (${t.overdueCount} cuota${t.overdueCount === 1 ? "" : "s"})` : "Vencido"}
            value={formatCurrency(t.overdue, t.currency)}
            alert={t.overdue > 0}
          />
          <p className="col-span-2 text-xs text-muted-foreground">
            Próximo pago: <span className="text-foreground">{fecha(t.nextDue)}</span>
          </p>
        </div>
      ))}

      {plans.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Planes de cuotas
          </h3>
          <ul className="space-y-2">
            {plans.map((p) => {
              const b = balanceById.get(p.id);
              const health = b ? HEALTH[planHealth(b)] : null;
              return (
                <li key={p.id} className="rounded-lg border border-border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{p.unit?.code ?? "Sin lote"}</span>
                    {health && (
                      <span className={`rounded-full px-2 py-0.5 text-xs ${health.className}`}>
                        {health.label}
                      </span>
                    )}
                  </div>
                  {b && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {b.paid_count} de {p.installments_count} cuotas pagadas · saldo{" "}
                      {formatCurrency(Number(b.pending_amount) || 0, b.currency)}
                      {b.next_due_date ? ` · próxima ${fecha(b.next_due_date)}` : ""}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          <Link href="/payment-plans" className="text-xs text-primary hover:underline">
            Ver en Cuotas
          </Link>
        </section>
      )}

      {reservations.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Separaciones
          </h3>
          <ul className="space-y-2">
            {reservations.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
                <span>
                  {(r.units ?? []).map((u) => u.unit?.code).filter(Boolean).join(", ") || "Sin lote"}
                  <span className="ml-2 text-xs text-muted-foreground">{fecha(r.created_at)}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {RESERVATION_LABEL[r.status] ?? r.status} ·{" "}
                  {formatCurrency(Number(r.total_amount) || 0, r.currency)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-2.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={alert ? "text-sm font-semibold text-rose-400" : "text-sm font-semibold"}>{value}</p>
    </div>
  );
}
