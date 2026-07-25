"use client";

import type { RealEstateUnit } from "@/types";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { Home } from "lucide-react";

// Status → left-border + dot color. Mirrors the CRM's plano
// legend: verde = disponible, amarillo = reservado, rojo = vendido.
const STATUS_STYLE: Record<
  RealEstateUnit["status"],
  { border: string; dot: string; label: string }
> = {
  disponible: {
    border: "border-l-green-500",
    dot: "bg-green-500",
    label: "Disponible",
  },
  reservado: {
    border: "border-l-amber-500",
    dot: "bg-amber-500",
    label: "Reservado",
  },
  vendido: {
    border: "border-l-red-500",
    dot: "bg-red-500",
    label: "Vendido",
  },
};

interface UnitCardProps {
  unit: RealEstateUnit;
  onClick?: () => void;
}

export function UnitCard({ unit, onClick }: UnitCardProps) {
  const style = STATUS_STYLE[unit.status];

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full flex-col gap-2 rounded-lg border border-border border-l-4 bg-card p-3 text-left transition-colors hover:bg-muted/50",
        style.border,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Home className="h-3.5 w-3.5 text-muted-foreground" />
          {unit.code}
        </span>
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span className={cn("h-2 w-2 rounded-full", style.dot)} />
          {style.label}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {unit.area_total != null && <span>{unit.area_total} m² total</span>}
        {unit.area_techada != null && <span>{unit.area_techada} m² techado</span>}
        {unit.rooms?.length ? <span>{unit.rooms.length} ambientes</span> : null}
      </div>

      {unit.price != null && (
        <p className="text-sm font-semibold text-foreground">
          {formatCurrency(unit.price, unit.currency)}
        </p>
      )}
    </button>
  );
}
