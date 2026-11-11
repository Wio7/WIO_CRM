// Pantalla "Gestiones" de la app de Cobranzas: reúne las reglas que ya
// existen en collection-actions (última gestión por cliente, estado de la
// promesa) sin duplicarlas.

import { latestByContact, promiseState, type CollectionAction } from "@/lib/collection-actions";

export type VistaGestiones = "vencidas" | "vigentes" | "recientes";

export interface ResumenGestiones {
  vencidas: number;
  vigentes: number;
  clientes: number;
  total: number;
}

export function resumenGestiones(acciones: readonly CollectionAction[], hoy: string): ResumenGestiones {
  const ultimas = latestByContact(acciones);
  let vencidas = 0;
  let vigentes = 0;
  for (const a of ultimas.values()) {
    const e = promiseState(a, hoy);
    if (e === "vencida") vencidas += 1;
    else if (e === "vigente") vigentes += 1;
  }
  return { vencidas, vigentes, clientes: ultimas.size, total: acciones.length };
}

/** Filas de cada vista. No modifica la lista que recibe. */
export function ordenarGestiones<T extends CollectionAction>(
  acciones: readonly T[],
  vista: VistaGestiones,
  hoy: string,
): T[] {
  if (vista === "recientes") return [...acciones].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const ultimas = latestByContact(acciones);
  const estado = vista === "vencidas" ? "vencida" : "vigente";
  const filas = acciones.filter((a) => ultimas.get(a.contact_id)?.id === a.id && promiseState(a, hoy) === estado);
  // Vencidas: la más atrasada primero; por cumplir: la más próxima primero.
  return filas.sort((a, b) => (a.promise_date ?? "").localeCompare(b.promise_date ?? ""));
}
