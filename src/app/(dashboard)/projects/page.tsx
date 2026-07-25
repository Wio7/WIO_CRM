"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import type { ProjectStatus, RealEstateProject, RealEstateUnit, UnitStatus } from "@/types";
import { GatedButton } from "@/components/ui/gated-button";
import { Input } from "@/components/ui/input";
import { ProjectCard } from "@/components/projects/project-card";
import { ProjectForm } from "@/components/projects/project-form";
import { ProjectDetail } from "@/components/projects/project-detail";
import { Building2, Plus, Search } from "lucide-react";

type StatusFilter = "all" | ProjectStatus;

function countByStatus(units: { status: UnitStatus }[]) {
  const counts: Record<UnitStatus, number> = { disponible: 0, reservado: 0, vendido: 0 };
  for (const u of units) counts[u.status]++;
  return counts;
}

export default function ProjectsPage() {
  const supabase = createClient();
  const router = useRouter();
  const { accountId } = useAuth();
  const canEdit = useCan("edit-settings");

  const [projects, setProjects] = useState<RealEstateProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const [formOpen, setFormOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<RealEstateProject | null>(null);
  const [selectedProject, setSelectedProject] = useState<RealEstateProject | null>(null);

  const loadProjects = useCallback(async () => {
    const { data, error } = await supabase
      .from("real_estate_projects")
      .select("*, real_estate_units(id, status)")
      .order("created_at", { ascending: false });
    if (error) {
      console.error("Failed to load projects:", error.message);
      return;
    }
    const list = (data ?? []).map((row) => {
      const { real_estate_units, ...project } = row as RealEstateProject & {
        real_estate_units: { id: string; status: UnitStatus }[];
      };
      return {
        ...project,
        unit_counts: countByStatus(real_estate_units ?? []),
      } as RealEstateProject;
    });
    setProjects(list);
  }, [supabase]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await loadProjects();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadProjects]);

  // Keep the drill-down view in sync with the underlying list after a
  // save (e.g. unit counts changing) without losing the selection.
  useEffect(() => {
    if (!selectedProject) return;
    const fresh = projects.find((p) => p.id === selectedProject.id);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (fresh) setSelectedProject(fresh);
  }, [projects, selectedProject]);

  const filtered = projects.filter((p) => {
    const matchesSearch =
      !search.trim() ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.city ?? "").toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || p.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  function handleReserveUnit(unit: RealEstateUnit) {
    router.push(`/reservations?unitId=${unit.id}`);
  }

  if (selectedProject) {
    return (
      <ProjectDetail
        project={selectedProject}
        onBack={() => setSelectedProject(null)}
        onEditProject={() => {
          setEditingProject(selectedProject);
          setFormOpen(true);
        }}
        onReserveUnit={handleReserveUnit}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre o ciudad..."
            className="border-border bg-card pl-8 text-foreground"
          />
        </div>

        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="h-9 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground outline-none focus:border-primary"
          >
            <option value="all">Todos los estados</option>
            <option value="active">Activo</option>
            <option value="sold_out">Agotado</option>
            <option value="coming_soon">Próximamente</option>
          </select>
          <GatedButton
            canAct={canEdit}
            gateReason="crear proyectos"
            onClick={() => {
              setEditingProject(null);
              setFormOpen(true);
            }}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="mr-1 h-4 w-4" />
            Nuevo Proyecto
          </GatedButton>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-64 animate-pulse rounded-xl bg-muted/50" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20">
          <Building2 className="h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-medium text-foreground">
            {projects.length === 0 ? "Sin proyectos aún" : "Sin resultados"}
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {projects.length === 0
              ? "Crea tu primer proyecto inmobiliario para empezar."
              : "Ajusta tu búsqueda o filtro."}
          </p>
          {projects.length === 0 && (
            <GatedButton
              canAct={canEdit}
              gateReason="crear proyectos"
              onClick={() => {
                setEditingProject(null);
                setFormOpen(true);
              }}
              className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="mr-1 h-4 w-4" />
              Crear Proyecto
            </GatedButton>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onClick={() => setSelectedProject(project)}
            />
          ))}
        </div>
      )}

      {accountId && (
        <ProjectForm
          open={formOpen}
          onOpenChange={setFormOpen}
          accountId={accountId}
          project={editingProject}
          onSaved={loadProjects}
        />
      )}
    </div>
  );
}
