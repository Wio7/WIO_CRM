"use client";

import type { RealEstateProject } from "@/types";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { Building2, MapPin } from "lucide-react";

const STATUS_BADGE: Record<RealEstateProject["status"], { label: string; className: string }> = {
  active: {
    label: "Activo",
    className: "border-green-500/40 bg-green-500/10 text-green-400",
  },
  sold_out: {
    label: "Agotado",
    className: "border-red-500/40 bg-red-500/10 text-red-400",
  },
  coming_soon: {
    label: "Próximamente",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  },
};

interface ProjectCardProps {
  project: RealEstateProject;
  onClick: () => void;
}

export function ProjectCard({ project, onClick }: ProjectCardProps) {
  const badge = STATUS_BADGE[project.status];
  const counts = project.unit_counts ?? { disponible: 0, reservado: 0, vendido: 0 };
  const total = counts.disponible + counts.reservado + counts.vendido;

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:bg-muted/40"
    >
      <div className="relative h-32 w-full bg-gradient-to-br from-primary/30 to-primary/5">
        {project.cover_image_url ? (
          <img
            src={project.cover_image_url}
            alt={project.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Building2 className="h-10 w-10 text-primary/40" />
          </div>
        )}
        <span
          className={cn(
            "absolute top-2 right-2 rounded-full border px-2 py-0.5 text-xs font-medium",
            badge.className,
          )}
        >
          {badge.label}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <div>
          <h3 className="font-semibold text-foreground">{project.name}</h3>
          {(project.city || project.location) && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="h-3 w-3" />
              {[project.city, project.location].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
          {project.price_cash != null && (
            <span className="font-semibold text-foreground">
              {formatCurrency(project.price_cash, "PEN")}
            </span>
          )}
          {project.area_from != null && (
            <span className="text-xs text-muted-foreground">
              desde {project.area_from} m²
            </span>
          )}
        </div>

        {project.amenities?.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {project.amenities.slice(0, 3).map((a) => (
              <span
                key={a}
                className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                {a}
              </span>
            ))}
          </div>
        )}

        {total > 0 && (
          <div className="mt-auto pt-2">
            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
              {counts.disponible > 0 && (
                <div
                  className="bg-green-500"
                  style={{ width: `${(counts.disponible / total) * 100}%` }}
                />
              )}
              {counts.reservado > 0 && (
                <div
                  className="bg-amber-500"
                  style={{ width: `${(counts.reservado / total) * 100}%` }}
                />
              )}
              {counts.vendido > 0 && (
                <div
                  className="bg-red-500"
                  style={{ width: `${(counts.vendido / total) * 100}%` }}
                />
              )}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {counts.disponible} disponibles · {counts.reservado} reservadas · {counts.vendido} vendidas
            </p>
          </div>
        )}
      </div>
    </button>
  );
}
