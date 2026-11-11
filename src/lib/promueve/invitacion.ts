// ============================================================
// Invitación de asesores Promueve por el procedimiento del equipo
// (migración 091). Funciones puras; las usan POST/GET
// /api/account/invitations y /api/invitations/[token]/enter.
// ============================================================

import type { AccountRole } from "@/lib/auth/roles";

/** Áreas que una invitación puede llevar (hoy solo Promueve). */
export const AREA_INVITACION = "promueve" as const;

export type AreaInvitacion = typeof AREA_INVITACION;

export type ResultadoArea =
  | { ok: true; area: AreaInvitacion | null }
  | { ok: false; error: string };

/**
 * Valida el `area` que llega en el cuerpo de una invitación. Vacío = una
 * invitación normal. `promueve` solo con rol `agent`: un Promueve es siempre
 * un agente externo (la base lo exige también con un check).
 */
export function areaDeInvitacion(area: unknown, role: AccountRole): ResultadoArea {
  if (area === undefined || area === null || area === "") return { ok: true, area: null };
  if (area !== AREA_INVITACION) {
    return { ok: false, error: "'area' must be 'promueve' when given" };
  }
  if (role !== "agent") {
    return { ok: false, error: "The 'promueve' area is only valid with role 'agent'" };
  }
  return { ok: true, area: AREA_INVITACION };
}

export type EstadoInvitacion = "pendiente" | "aceptada" | "vencida";

/** Estado de una invitación para la lista del equipo. */
export function estadoInvitacion(
  inv: { accepted_at: string | null; expires_at: string },
  ahora: Date = new Date(),
): EstadoInvitacion {
  if (inv.accepted_at) return "aceptada";
  return new Date(inv.expires_at) <= ahora ? "vencida" : "pendiente";
}
