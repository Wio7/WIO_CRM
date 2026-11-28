// Avisos al celular de abonos por validar (Golden Habitat).
// Cobranzas manda un abono a Gerencia (gerencia_solicitudes, kind
// 'validacion_abono', migración 101) y Gerencia debe validarlo el mismo día
// (pedido de la administradora, 2026-11-28). Dos avisos:
//   - al instante: /api/golden/abono-por-validar
//   - 5 pm Lima, si quedan abonos del día: /api/golden/abonos-pendientes (cron)
// Reciben los dueños de la cuenta y el área gerencia (la misma regla que
// is_owner_or_gerencia), salvo solo lectura.

import type { SupabaseClient } from "@supabase/supabase-js";

export const URL_ABONOS = "https://gerencia-golden.vercel.app/aprobaciones";
export const MINUTOS_RECIENTE = 10;
const LIMA_MS = -5 * 3600 * 1000; // Perú no cambia de hora.

export interface PerfilAviso {
  user_id: string;
  account_role: string | null;
  area: string | null;
}

export function destinatariosGerencia(perfiles: readonly PerfilAviso[], excepto?: string | null): string[] {
  return perfiles
    .filter((p) => p.account_role !== "viewer")
    .filter((p) => p.account_role === "owner" || p.area === "gerencia")
    .map((p) => p.user_id)
    .filter((id) => id !== excepto);
}

const texto = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

function monto(resumen: Record<string, unknown>): string | null {
  const c = Number(resumen.monto_centimos);
  if (!Number.isFinite(c) || c <= 0) return null;
  const simbolo = resumen.moneda === "USD" ? "US$" : "S/";
  return `${simbolo} ${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function textoAvisoAbono(s: { resumen: Record<string, unknown> | null; solicitado_por_nombre: string | null }): {
  title: string;
  body: string;
} {
  const r = s.resumen ?? {};
  const lote = [texto(r.proyecto), texto(r.unidad)].filter(Boolean).join(" ");
  const partes = [texto(r.cliente), lote || null, monto(r)].filter(Boolean);
  const quien = texto(s.solicitado_por_nombre);
  const cuerpo = partes.length ? partes.join(" · ") : "Nuevo abono";
  return { title: "Abono por validar", body: quien ? `${cuerpo} (de ${quien})` : cuerpo };
}

export function solicitudReciente(createdAt: string, ahora: Date): boolean {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return false;
  const edad = ahora.getTime() - t;
  return edad >= -60_000 && edad < MINUTOS_RECIENTE * 60_000;
}

/** Medianoche de Lima del día en curso en Lima, como instante UTC. */
export function inicioDiaLima(ahora: Date): Date {
  const lima = new Date(ahora.getTime() + LIMA_MS);
  return new Date(Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth(), lima.getUTCDate()) - LIMA_MS);
}

export function esperaTexto(desdeIso: string, ahora: Date): string {
  const min = Math.max(0, Math.round((ahora.getTime() - Date.parse(desdeIso)) / 60_000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function textoAbonosPendientes(cantidad: number, masAntiguo: string, ahora: Date): { title: string; body: string } {
  const espera = esperaTexto(masAntiguo, ahora);
  const body =
    cantidad === 1
      ? `1 abono de hoy sigue sin validar. Espera desde hace ${espera}.`
      : `${cantidad} abonos de hoy siguen sin validar. El más antiguo espera ${espera}.`;
  return { title: "Abonos sin validar", body };
}

// ---------- lectura de la base (cliente de servicio) ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const esUuidAbono = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export interface SolicitudAbono {
  id: string;
  account_id: string;
  kind: string;
  estado: string;
  created_at: string;
  resumen: Record<string, unknown> | null;
  solicitado_por: string | null;
  solicitado_por_nombre: string | null;
}

export async function leerSolicitudAbono(db: SupabaseClient, id: string): Promise<SolicitudAbono | null | "error"> {
  const { data, error } = await db
    .from("gerencia_solicitudes")
    .select("id, account_id, kind, estado, created_at, resumen, solicitado_por, solicitado_por_nombre")
    .eq("id", id)
    .maybeSingle();
  if (error) return "error";
  return (data as SolicitudAbono | null) ?? null;
}

export async function perfilesCuenta(db: SupabaseClient, accountId: string): Promise<PerfilAviso[]> {
  const { data } = await db.from("profiles").select("user_id, account_role, area").eq("account_id", accountId);
  return (data ?? []) as PerfilAviso[];
}

export interface PendientesCuenta {
  account_id: string;
  cantidad: number;
  masAntiguo: string;
}

/** Abonos pendientes creados desde `desde`, agrupados por cuenta. */
export function agruparPendientes(filas: readonly { account_id: string; created_at: string }[]): PendientesCuenta[] {
  const mapa = new Map<string, PendientesCuenta>();
  for (const f of filas) {
    const p = mapa.get(f.account_id);
    if (!p) mapa.set(f.account_id, { account_id: f.account_id, cantidad: 1, masAntiguo: f.created_at });
    else {
      p.cantidad += 1;
      if (Date.parse(f.created_at) < Date.parse(p.masAntiguo)) p.masAntiguo = f.created_at;
    }
  }
  return [...mapa.values()];
}

export async function pendientesDesde(db: SupabaseClient, desde: Date): Promise<PendientesCuenta[] | "error"> {
  const { data, error } = await db
    .from("gerencia_solicitudes")
    .select("account_id, created_at")
    .eq("kind", "validacion_abono")
    .eq("estado", "pendiente")
    .gte("created_at", desde.toISOString());
  if (error) return "error";
  return agruparPendientes((data ?? []) as { account_id: string; created_at: string }[]);
}
