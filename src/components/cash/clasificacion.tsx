'use client';

import { useState } from 'react';
import { RUBROS, RUBRO_ETIQUETAS, esRubro, type Rubro } from '@/lib/cash/clasificar';

export interface ProyectoOpcion {
  id: string;
  name: string;
}

/** Valor del selector de proyecto: '' (sin elegir), 'general' o el id del proyecto. */
export function leerProyecto(valor: FormDataEntryValue | null): { projectId?: string; projectGeneral?: true } {
  const v = String(valor ?? '');
  if (v === 'general') return { projectGeneral: true };
  return v ? { projectId: v } : {};
}

/** Los dos selectores del formulario de gasto. `required` en gastos nuevos. */
export function CamposClasificacion({
  projects,
  required,
  rubro,
  proyecto,
}: {
  projects: ProyectoOpcion[];
  required: boolean;
  rubro?: string | null;
  proyecto?: string;
}) {
  return (
    <>
      <label>
        Rubro
        <select name="rubro" required={required} defaultValue={rubro ?? ''}>
          <option value="">{required ? 'Elige el rubro' : 'Sin asignar'}</option>
          {RUBROS.map((r) => (
            <option key={r} value={r}>{RUBRO_ETIQUETAS[r]}</option>
          ))}
        </select>
      </label>
      <label>
        Proyecto
        <select name="projectChoice" required={required} defaultValue={proyecto ?? ''}>
          <option value="">{required ? 'Elige el proyecto' : 'Sin asignar'}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
          <option value="general">Gasto general (sin proyecto)</option>
        </select>
      </label>
    </>
  );
}

export function etiquetaProyecto(
  e: { project_id?: string | null; project_general?: boolean },
  projects: ProyectoOpcion[]
): string | null {
  if (e.project_id) return projects.find((p) => p.id === e.project_id)?.name ?? 'Proyecto';
  return e.project_general ? 'Gasto general' : null;
}

export function sinAsignar(e: { kind?: string; rubro?: string | null; project_id?: string | null; project_general?: boolean }) {
  return e.kind !== 'income' && (!e.rubro || (!e.project_id && !e.project_general));
}

/** Rubro y proyecto de un movimiento, con "Completar" cuando falta algo. */
export function Clasificacion({
  entryId,
  rubro,
  projectId,
  projectGeneral,
  projects,
  canEdit,
  onDone,
}: {
  entryId: string;
  rubro?: string | null;
  projectId?: string | null;
  projectGeneral?: boolean;
  projects: ProyectoOpcion[];
  canEdit: boolean;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const proyecto = projectId ? projects.find((p) => p.id === projectId)?.name ?? 'Proyecto' : projectGeneral ? 'Gasto general' : null;
  const falta = !rubro || !proyecto;

  async function guardar(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const r = String(values.get('rubro') ?? '');
    const p = leerProyecto(values.get('projectChoice'));
    if (!esRubro(r) || (!p.projectId && !p.projectGeneral)) {
      setError('Elige el rubro y el proyecto.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/caja/clasificar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId, rubro: r, ...p }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'No se pudo guardar.');
      setOpen(false);
      setError('');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="cash-class">
      <span className={`cash-chip ${rubro ? '' : 'pending'}`}>{rubro ? RUBRO_ETIQUETAS[rubro as Rubro] ?? rubro : 'Rubro: sin asignar'}</span>
      <span className={`cash-chip ${proyecto ? '' : 'pending'}`}>{proyecto ?? 'Proyecto: sin asignar'}</span>
      {falta && canEdit && !open && (
        <button type="button" className="cash-link" onClick={() => setOpen(true)}>Completar</button>
      )}
      {open && (
        <form className="cash-class-form" onSubmit={guardar}>
          <CamposClasificacion
            projects={projects}
            required
            rubro={rubro}
            proyecto={projectId ?? (projectGeneral ? 'general' : '')}
          />
          <button className="cash-button primary" disabled={saving} type="submit">{saving ? 'Guardando…' : 'Guardar'}</button>
          <button className="cash-button secondary" type="button" onClick={() => setOpen(false)}>Cancelar</button>
          {error && <small role="alert" className="cash-class-error">{error}</small>}
        </form>
      )}
    </span>
  );
}
