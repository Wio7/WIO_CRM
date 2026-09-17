"use client";

// ============================================================
// /payment-plans — collections at a glance.
//
// One row per client plan with what they owe, what's overdue and when
// the next instalment falls due. The numbers come from the
// `payment_plan_balances` view (migration 043), never from arithmetic
// here: two screens computing the same balance eventually disagree, and
// the client sees whichever one is wrong.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useCan } from "@/hooks/use-can";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";
import type { Contact, PaymentPlan, PaymentPlanBalance } from "@/types";
import { GatedButton } from "@/components/ui/gated-button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { PaymentPlanForm } from "@/components/payment-plans/payment-plan-form";
import { PaymentPlanDetail } from "@/components/payment-plans/payment-plan-detail";
import { Plus, Wallet } from "lucide-react";

type Filtro = "todos" | "al-dia" | "vencidos" | "pagados";

type Fila = PaymentPlan & { balance?: PaymentPlanBalance; contact?: Contact };

const FILTROS: { key: Filtro; label: string }[] = [
  { key: "todos", label: "Todos" },
  { key: "vencidos", label: "Con atraso" },
  { key: "al-dia", label: "Al día" },
  { key: "pagados", label: "Pagados" },
];

const fecha = (iso: string | null | undefined) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }) : "—";

export default function PaymentPlansPage() {
  const supabase = createClient();
  const canCreate = useCan("send-messages");

  const [planes, setPlanes] = useState<Fila[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [busqueda, setBusqueda] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  // El plan abierto en la hoja de detalle, o null. La fila entera abre:
  // el asesor viene a cobrar, no a leer una tabla.
  const [abierto, setAbierto] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const [{ data: filas, error }, { data: saldos }] = await Promise.all([
      supabase
        .from("payment_plans")
        .select("*, contact:contacts(*), unit:real_estate_units(*)")
        .order("created_at", { ascending: false }),
      supabase.from("payment_plan_balances").select("*"),
    ]);

    if (error) {
      console.error("[payment-plans] load:", error.message);
      return;
    }

    const porPlan = new Map(
      (saldos ?? []).map((s) => [(s as PaymentPlanBalance).plan_id, s as PaymentPlanBalance]),
    );
    setPlanes(
      (filas ?? []).map((p) => ({
        ...(p as Fila),
        balance: porPlan.get((p as Fila).id),
      })),
    );
  }, [supabase]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await cargar();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [cargar]);

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return planes.filter((p) => {
      const b = p.balance;
      const pasaFiltro =
        filtro === "todos" ||
        (filtro === "vencidos" && (b?.overdue_count ?? 0) > 0) ||
        (filtro === "al-dia" && (b?.overdue_count ?? 0) === 0 && (b?.pending_count ?? 0) > 0) ||
        (filtro === "pagados" && (b?.pending_count ?? 0) === 0);
      if (!pasaFiltro) return false;
      if (!q) return true;
      // Buscar por nombre, teléfono o DNI: los tres datos con los que el
      // asesor identifica a un cliente por teléfono.
      const c = p.contact;
      return [c?.name, c?.phone, c?.dni, p.unit?.code]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [planes, filtro, busqueda]);

  const totales = useMemo(() => {
    const conAtraso = planes.filter((p) => (p.balance?.overdue_count ?? 0) > 0);
    const pendiente = planes.reduce((s, p) => s + (p.balance?.pending_amount ?? 0), 0);
    const atrasado = conAtraso.reduce((s, p) => s + (p.balance?.overdue_amount ?? 0), 0);
    const moneda = planes[0]?.currency ?? "PEN";
    return { planes: planes.length, conAtraso: conAtraso.length, pendiente, atrasado, moneda };
  }, [planes]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xl font-bold text-foreground">{totales.planes}</p>
            <p className="text-xs text-muted-foreground">Planes</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xl font-bold text-red-400">{totales.conAtraso}</p>
            <p className="text-xs text-muted-foreground">Con atraso</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xl font-bold text-amber-400">
              {formatCurrency(totales.atrasado, totales.moneda)}
            </p>
            <p className="text-xs text-muted-foreground">Monto atrasado</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xl font-bold text-primary">
              {formatCurrency(totales.pendiente, totales.moneda)}
            </p>
            <p className="text-xs text-muted-foreground">Por cobrar</p>
          </div>
        </div>

        <GatedButton
          canAct={canCreate}
          gateReason="crear planes de cuotas"
          onClick={() => setFormOpen(true)}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="mr-2 h-4 w-4" />
          Nuevo plan
        </GatedButton>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTROS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFiltro(f.key)}
            className={cn(
              "rounded-lg px-3 py-2 text-sm transition-colors",
              filtro === f.key
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
        <Input
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar por nombre, teléfono o DNI"
          className="ml-auto w-full border-border bg-muted text-foreground sm:w-72"
        />
      </div>

      {loading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          Cargando planes…
        </p>
      ) : visibles.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-16 text-center">
          <Wallet className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            {planes.length === 0 ? "Todavía no hay planes de cuotas" : "Nada con ese filtro"}
          </p>
          <p className="max-w-sm text-xs text-muted-foreground">
            {planes.length === 0
              ? "Crea el primero con el precio, la inicial y el número de cuotas: las fechas se calculan solas."
              : "Prueba con otro filtro o limpia la búsqueda."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Unidad</TableHead>
                <TableHead>Cuota</TableHead>
                <TableHead>Pagadas</TableHead>
                <TableHead>Próxima</TableHead>
                <TableHead>Atraso</TableHead>
                <TableHead>Por cobrar</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibles.map((p) => {
                const b = p.balance;
                const atraso = b?.overdue_count ?? 0;
                return (
                  <TableRow
                    key={p.id}
                    onClick={() => setAbierto(p.id)}
                    className="cursor-pointer"
                  >
                    <TableCell>
                      <span className="font-medium text-foreground">
                        {p.contact?.name || p.contact?.phone || "—"}
                      </span>
                      {p.contact?.dni && (
                        <span className="block text-xs text-muted-foreground">
                          DNI {p.contact.dni}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.unit?.code ?? "—"}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatCurrency(p.monthly_amount, p.currency)}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {b ? `${b.paid_count} de ${p.installments_count}` : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {fecha(b?.next_due_date)}
                    </TableCell>
                    <TableCell>
                      {atraso > 0 ? (
                        <span className="rounded-md border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-xs text-red-400">
                          {atraso} {atraso === 1 ? "cuota" : "cuotas"}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Al día</span>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatCurrency(b?.pending_amount ?? 0, p.currency)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <PaymentPlanForm open={formOpen} onOpenChange={setFormOpen} onSaved={cargar} />
      <PaymentPlanDetail
        planId={abierto}
        onOpenChange={(open) => {
          if (!open) setAbierto(null);
        }}
        onChanged={cargar}
      />
    </div>
  );
}
