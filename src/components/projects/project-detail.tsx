"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import type { RealEstateProject, RealEstateUnit, UnitStatus } from "@/types";
import { formatCurrency } from "@/lib/currency";
import { GatedButton } from "@/components/ui/gated-button";
import { Button } from "@/components/ui/button";
import { UnitCard } from "@/components/projects/unit-card";
import { UnitForm } from "@/components/projects/unit-form";
import { UnitDetailSheet } from "@/components/projects/unit-detail-sheet";
import { ArrowLeft, Building2, MapPin, Pencil, Plus } from "lucide-react";

interface ProjectDetailProps {
  project: RealEstateProject;
  onBack: () => void;
  onEditProject: () => void;
  onReserveUnit?: (unit: RealEstateUnit) => void;
}

function statusCounts(units: RealEstateUnit[]): Record<UnitStatus, number> {
  const counts: Record<UnitStatus, number> = { disponible: 0, reservado: 0, vendido: 0 };
  for (const u of units) counts[u.status]++;
  return counts;
}

export function ProjectDetail({
  project,
  onBack,
  onEditProject,
  onReserveUnit,
}: ProjectDetailProps) {
  const supabase = createClient();
  const { accountId } = useAuth();
  const canEdit = useCan("edit-settings");

  const [units, setUnits] = useState<RealEstateUnit[]>([]);
  const [loading, setLoading] = useState(true);

  const [unitFormOpen, setUnitFormOpen] = useState(false);
  const [editingUnit, setEditingUnit] = useState<RealEstateUnit | null>(null);
  const [detailUnit, setDetailUnit] = useState<RealEstateUnit | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const loadUnits = useCallback(async () => {
    const { data, error } = await supabase
      .from("real_estate_units")
      .select("*")
      .eq("project_id", project.id)
      .order("code");
    if (error) {
      console.error("Failed to load units:", error.message);
      return;
    }
    setUnits((data ?? []) as RealEstateUnit[]);
  }, [supabase, project.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await loadUnits();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadUnits]);

  const counts = statusCounts(units);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-foreground">{project.name}</h2>
          {(project.city || project.location) && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="h-3 w-3" />
              {[project.city, project.location].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
        <GatedButton
          variant="outline"
          canAct={canEdit}
          gateReason="editar proyectos"
          onClick={onEditProject}
          className="border-border bg-card text-foreground hover:bg-muted"
        >
          <Pencil className="mr-1 h-4 w-4" />
          Editar
        </GatedButton>
      </div>

      {project.description && (
        <p className="text-sm text-muted-foreground">{project.description}</p>
      )}

      {/* Pricing summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {project.initial_from != null && (
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">Inicial desde</p>
            <p className="text-base font-semibold text-foreground">
              {formatCurrency(project.initial_from, "PEN")}
            </p>
          </div>
        )}
        {project.price_cash != null && (
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">Al contado</p>
            <p className="text-base font-semibold text-foreground">
              {formatCurrency(project.price_cash, "PEN")}
            </p>
          </div>
        )}
        {project.monthly_payment != null && (
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">Cuota mensual</p>
            <p className="text-base font-semibold text-foreground">
              {formatCurrency(project.monthly_payment, "PEN")}
              {project.financing_months ? ` × ${project.financing_months}` : ""}
            </p>
          </div>
        )}
        {project.area_from != null && (
          <div className="rounded-lg border border-border bg-card p-3">
            <p className="text-xs text-muted-foreground">Área desde</p>
            <p className="text-base font-semibold text-foreground">{project.area_from} m²</p>
          </div>
        )}
      </div>

      {/* Unit status stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-border bg-card p-3 text-center">
          <p className="text-xl font-bold text-green-400">{counts.disponible}</p>
          <p className="text-xs text-muted-foreground">Disponibles</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3 text-center">
          <p className="text-xl font-bold text-amber-400">{counts.reservado}</p>
          <p className="text-xs text-muted-foreground">Reservadas</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3 text-center">
          <p className="text-xl font-bold text-red-400">{counts.vendido}</p>
          <p className="text-xs text-muted-foreground">Vendidas</p>
        </div>
      </div>

      {/* Units grid */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Unidades</h3>
          <GatedButton
            size="sm"
            canAct={canEdit}
            gateReason="agregar unidades"
            onClick={() => {
              setEditingUnit(null);
              setUnitFormOpen(true);
            }}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Agregar Unidad
          </GatedButton>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-lg bg-muted/50" />
            ))}
          </div>
        ) : units.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-12">
            <Building2 className="h-10 w-10 text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">Sin unidades registradas</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {units.map((unit) => (
              <UnitCard
                key={unit.id}
                unit={unit}
                onClick={() => {
                  setDetailUnit(unit);
                  setDetailOpen(true);
                }}
              />
            ))}
          </div>
        )}
      </div>

      {accountId && (
        <UnitForm
          open={unitFormOpen}
          onOpenChange={setUnitFormOpen}
          projectId={project.id}
          accountId={accountId}
          unit={editingUnit}
          onSaved={loadUnits}
        />
      )}

      <UnitDetailSheet
        open={detailOpen}
        onOpenChange={setDetailOpen}
        unit={detailUnit}
        canEdit={canEdit}
        onEdit={() => {
          setDetailOpen(false);
          setEditingUnit(detailUnit);
          setUnitFormOpen(true);
        }}
        onReserve={
          onReserveUnit && detailUnit
            ? () => {
                setDetailOpen(false);
                onReserveUnit(detailUnit);
              }
            : undefined
        }
      />
    </div>
  );
}
