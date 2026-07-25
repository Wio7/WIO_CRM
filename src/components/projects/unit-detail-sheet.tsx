"use client";

import type { RealEstateUnit } from "@/types";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import { Pencil, Ruler, Layers, Zap } from "lucide-react";

const STATUS_LABEL: Record<RealEstateUnit["status"], string> = {
  disponible: "Disponible",
  reservado: "Reservado",
  vendido: "Vendido",
};

const STATUS_BADGE: Record<RealEstateUnit["status"], string> = {
  disponible: "border-green-500/40 bg-green-500/10 text-green-400",
  reservado: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  vendido: "border-red-500/40 bg-red-500/10 text-red-400",
};

interface UnitDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unit: RealEstateUnit | null;
  canEdit: boolean;
  onEdit: () => void;
  onReserve?: () => void;
}

function Field({ label, value }: { label: string; value?: string | number | null }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground">{value}</p>
    </div>
  );
}

export function UnitDetailSheet({
  open,
  onOpenChange,
  unit,
  canEdit,
  onEdit,
  onReserve,
}: UnitDetailSheetProps) {
  if (!unit) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <div className="flex items-center justify-between gap-2">
              <SheetTitle className="text-popover-foreground">{unit.code}</SheetTitle>
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs font-medium",
                  STATUS_BADGE[unit.status],
                )}
              >
                {STATUS_LABEL[unit.status]}
              </span>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {unit.price != null && (
              <div className="rounded-lg border border-border bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground">Precio</p>
                <p className="text-xl font-bold text-foreground">
                  {formatCurrency(unit.price, unit.currency)}
                </p>
              </div>
            )}

            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <Ruler className="h-3.5 w-3.5" /> Áreas
              </p>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Total" value={unit.area_total ? `${unit.area_total} m²` : null} />
                <Field label="Techada" value={unit.area_techada ? `${unit.area_techada} m²` : null} />
                <Field label="No techada" value={unit.area_no_techada ? `${unit.area_no_techada} m²` : null} />
              </div>
            </div>

            {unit.rooms?.length > 0 && (
              <div>
                <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <Layers className="h-3.5 w-3.5" /> Ambientes
                </p>
                <div className="overflow-hidden rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <tbody>
                      {unit.rooms.map((room, i) => (
                        <tr key={i} className="border-b border-border last:border-0">
                          <td className="px-3 py-1.5 text-foreground">{room.name}</td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">
                            {room.area} m²
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <Zap className="h-3.5 w-3.5" /> Detalles constructivos
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Manzana" value={unit.manzana} />
                <Field label="Lote" value={unit.lote_number} />
                <Field label="Pisos" value={unit.floors} />
                <Field label="Altura piso" value={unit.height_floor ? `${unit.height_floor} m` : null} />
                <Field label="Altura total" value={unit.height_total ? `${unit.height_total} m` : null} />
                <Field label="Material" value={unit.material} />
                <Field label="Servicios" value={unit.services} />
                <Field label="Ventilación" value={unit.ventilation} />
              </div>
            </div>
          </div>

          <div className="flex gap-2 border-t border-border/50 bg-popover/80 p-4">
            <GatedButton
              variant="outline"
              canAct={canEdit}
              gateReason="editar unidades"
              onClick={onEdit}
              className="flex-1 border-border bg-transparent text-foreground hover:bg-muted"
            >
              <Pencil className="mr-1 h-4 w-4" />
              Editar
            </GatedButton>
            {onReserve && unit.status === "disponible" && (
              <Button
                onClick={onReserve}
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Separar
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
