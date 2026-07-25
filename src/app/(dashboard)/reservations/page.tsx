"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useCan } from "@/hooks/use-can";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";
import type { Reservation, ReservationStatus, RealEstateUnit } from "@/types";
import { GatedButton } from "@/components/ui/gated-button";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { ReservationForm } from "@/components/reservations/reservation-form";
import { ReservationDetail } from "@/components/reservations/reservation-detail";
import { CalendarCheck, Plus } from "lucide-react";

type TabFilter = "all" | ReservationStatus;

const STATUS_BADGE: Record<ReservationStatus, string> = {
  pendiente: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  aprobada: "border-primary/40 bg-primary/10 text-primary",
  rechazada: "border-red-500/40 bg-red-500/10 text-red-400",
  cerrada: "border-green-500/40 bg-green-500/10 text-green-400",
};

const STATUS_LABEL: Record<ReservationStatus, string> = {
  pendiente: "Pendiente",
  aprobada: "Aprobada",
  rechazada: "Rechazada",
  cerrada: "Cerrada",
};

const TABS: { key: TabFilter; label: string }[] = [
  { key: "all", label: "Todas" },
  { key: "pendiente", label: "Pendientes" },
  { key: "aprobada", label: "Aprobadas" },
  { key: "cerrada", label: "Cerradas" },
  { key: "rechazada", label: "Rechazadas" },
];

function ReservationsPageInner() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  const canCreate = useCan("send-messages");

  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabFilter>("all");

  const [formOpen, setFormOpen] = useState(false);
  const [initialUnitId, setInitialUnitId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [selected, setSelected] = useState<Reservation | null>(null);

  const loadReservations = useCallback(async () => {
    const { data, error } = await supabase
      .from("reservations")
      .select(
        "*, contact:contacts(*), advisor:profiles!reservations_advisor_id_fkey(*), reservation_units(unit:real_estate_units(*))",
      )
      .order("created_at", { ascending: false });
    if (error) {
      console.error("Failed to load reservations:", error.message);
      return;
    }
    const list = (data ?? []).map((row) => {
      const { reservation_units, ...rest } = row as Reservation & {
        reservation_units: { unit: RealEstateUnit }[];
      };
      return {
        ...rest,
        units: (reservation_units ?? []).map((ru) => ru.unit).filter(Boolean),
      } as Reservation;
    });
    setReservations(list);
  }, [supabase]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await loadReservations();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadReservations]);

  // Deep link from a unit's "Separar" action (/reservations?unitId=...)
  // opens the create form pre-scoped to that unit.
  useEffect(() => {
    const unitId = searchParams.get("unitId");
    if (unitId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInitialUnitId(unitId);
      setFormOpen(true);
    }
  }, [searchParams]);

  // Keep the open detail sheet in sync after a status change.
  useEffect(() => {
    if (!selected) return;
    const fresh = reservations.find((r) => r.id === selected.id);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (fresh) setSelected(fresh);
  }, [reservations, selected]);

  const filtered = tab === "all" ? reservations : reservations.filter((r) => r.status === tab);

  const counts = {
    total: reservations.length,
    pendiente: reservations.filter((r) => r.status === "pendiente").length,
    aprobada: reservations.filter((r) => r.status === "aprobada").length,
    cerrada: reservations.filter((r) => r.status === "cerrada").length,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xl font-bold text-foreground">{counts.total}</p>
            <p className="text-xs text-muted-foreground">Total</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xl font-bold text-amber-400">{counts.pendiente}</p>
            <p className="text-xs text-muted-foreground">Pendientes</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xl font-bold text-primary">{counts.aprobada}</p>
            <p className="text-xs text-muted-foreground">Aprobadas</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xl font-bold text-green-400">{counts.cerrada}</p>
            <p className="text-xs text-muted-foreground">Cerradas</p>
          </div>
        </div>

        <GatedButton
          canAct={canCreate}
          gateReason="crear separaciones"
          onClick={() => {
            setInitialUnitId(null);
            setFormOpen(true);
          }}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="mr-1 h-4 w-4" />
          Nueva Separación
        </GatedButton>
      </div>

      {/* Status tabs */}
      <div className="flex gap-1 overflow-x-auto rounded-lg border border-border bg-card p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === t.key
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/50" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20">
          <CalendarCheck className="h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-medium text-foreground">Sin separaciones</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Las separaciones de lotes/unidades aparecerán aquí.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead className="hidden md:table-cell">Unidad(es)</TableHead>
                <TableHead>Monto</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="hidden lg:table-cell">Asesor</TableHead>
                <TableHead className="hidden lg:table-cell">Fecha</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow
                  key={r.id}
                  onClick={() => {
                    setSelected(r);
                    setDetailOpen(true);
                  }}
                  className="cursor-pointer"
                >
                  <TableCell className="font-medium text-foreground">
                    {r.contact?.name || r.contact?.phone || "—"}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-muted-foreground">
                    {r.units?.map((u) => u.code).join(", ") || "—"}
                  </TableCell>
                  <TableCell className="text-foreground">
                    {formatCurrency(r.total_amount, r.currency)}
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-xs font-medium",
                        STATUS_BADGE[r.status],
                      )}
                    >
                      {STATUS_LABEL[r.status]}
                    </span>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-muted-foreground">
                    {r.advisor?.full_name || "—"}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-muted-foreground">
                    {new Date(r.created_at).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ReservationForm
        open={formOpen}
        onOpenChange={setFormOpen}
        initialUnitId={initialUnitId}
        onSaved={loadReservations}
      />

      <ReservationDetail
        open={detailOpen}
        onOpenChange={setDetailOpen}
        reservation={selected}
        onChanged={loadReservations}
      />
    </div>
  );
}

export default function ReservationsPage() {
  return (
    <Suspense fallback={<div className="h-8 w-48 animate-pulse rounded bg-muted" />}>
      <ReservationsPageInner />
    </Suspense>
  );
}
