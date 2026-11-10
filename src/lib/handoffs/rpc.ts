// ============================================================
// Traspasos entre áreas por RPC (migración 085).
//
// Las reglas (quién puede, a quién, tema obligatorio) las valida la base;
// aquí solo se llama y se devuelve su mensaje. Si 085 no está aplicada,
// PostgREST responde PGRST202: se avisa con `missing085`.
// ============================================================

import { isMissing084, type RpcClient } from "@/lib/payment-plans/rpc";

import type { HandoffKind, HandoffModule, HandoffTopic } from "./kinds";

export type HandoffBox = "recibidos" | "enviados";
export type HandoffStatus = "pendiente" | "aceptado" | "devuelto" | string;

/** Resumen que arma la base según el tipo (handoff_summary). */
export interface HandoffSummary {
  contact_id?: string | null;
  cliente?: string | null;
  telefono?: string | null;
  // pase_legal
  plan_id?: string | null;
  deuda_total?: number | null;
  cuotas_vencidas?: number | null;
  gestiones?: { fecha: string; resultado: string | null; nota: string | null }[];
  // postventa_*
  lote?: string | null;
  proyecto?: string | null;
}

/** Forma de cada fila de `my_handoffs`. */
export interface HandoffRow {
  id: string;
  kind: HandoffKind;
  status: HandoffStatus;
  topic: HandoffTopic | null;
  note: string | null;
  return_reason: string | null;
  sent_by_name: string | null;
  handled_by_name: string | null;
  created_at: string;
  handled_at: string | null;
  summary: HandoffSummary | null;
}

const MENSAJE_085 = "Falta aplicar la migración 085 (conexiones entre áreas) en Supabase.";

function fail(message: string): { ok: false; missing085: false; message: string } {
  return { ok: false, missing085: false, message };
}

async function llamar<T>(
  client: RpcClient,
  fn: string,
  args: Record<string, unknown>,
  map: (data: unknown) => T,
): Promise<{ ok: true; data: T } | { ok: false; missing085: boolean; message: string }> {
  const { data, error } = await client.rpc(fn, args);
  if (!error) return { ok: true, data: map(data) };
  if (isMissing084(error)) return { ok: false, missing085: true, message: MENSAJE_085 };
  return fail(error.message);
}

const POSTVENTA: HandoffKind[] = ["postventa_desde_cobranzas", "postventa_desde_legal"];

export async function sendHandoff(
  client: RpcClient,
  a: { kind: HandoffKind; entityId: string; note?: string | null; topic?: HandoffTopic | null },
): Promise<{ ok: true; data: string } | { ok: false; missing085: boolean; message: string }> {
  if (POSTVENTA.includes(a.kind) && !a.topic) return fail("Elige el tema del caso");
  return llamar(
    client,
    "send_handoff",
    { p_kind: a.kind, p_entity_id: a.entityId, p_note: a.note ?? null, p_topic: a.topic ?? null },
    (d) => d as string,
  );
}

export function acceptHandoff(client: RpcClient, id: string) {
  return llamar(client, "accept_handoff", { p_id: id }, () => undefined);
}

export async function returnHandoff(client: RpcClient, id: string, reason: string) {
  const motivo = reason.trim();
  if (!motivo) return fail("Escribe el motivo");
  return llamar(client, "return_handoff", { p_id: id, p_reason: motivo }, () => undefined);
}

export function listHandoffs(client: RpcClient, module: HandoffModule, box: HandoffBox) {
  return llamar(client, "my_handoffs", { p_module: module, p_box: box }, (d) =>
    ((d as HandoffRow[] | null) ?? []),
  );
}

export function destinationReady(client: RpcClient, kind: HandoffKind) {
  return llamar(client, "handoff_destination_ready", { p_kind: kind }, (d) => d === true);
}
