// Estado de cuenta del banco por RPC (migración 093). Las reglas (quién puede,
// duplicados, un pago por movimiento) las valida la base; aquí solo se arma el
// envío y se devuelve su mensaje. Si la 093 no está aplicada, PostgREST
// responde PGRST202: se avisa con `missing093`, sin escribir nada por otro lado.

import { isMissing084, type RpcClient } from "@/lib/payment-plans/rpc";

import type { EstadoMovimiento, MovimientoBanco, ResultadoLectura } from "./estado-cuenta";
import type { ResultadoConciliacion } from "./conciliacion";

export type ResultadoRpc<T> = { ok: true; data: T } | { ok: false; missing093: boolean; message: string };

const MENSAJE_093 = "Falta aplicar la migración 093 (estado de cuenta del banco) en Supabase.";

async function llamar<T>(client: RpcClient, fn: string, args: Record<string, unknown>, map: (d: unknown) => T): Promise<ResultadoRpc<T>> {
  const { data, error } = await client.rpc(fn, args);
  if (!error) return { ok: true, data: map(data) };
  if (isMissing084(error)) return { ok: false, missing093: true, message: MENSAJE_093 };
  return { ok: false, missing093: false, message: error.message };
}

export interface PayloadImportacion {
  banco: "caja_ica";
  cuenta: string | null;
  archivo: string | null;
  periodo_desde: string | null;
  periodo_hasta: string | null;
  filas: {
    fecha_hora: string;
    descripcion: string;
    tipo: string;
    propio: boolean;
    deposito: number;
    retiro: number;
    saldo: number | null;
    agencia: string | null;
    huella: string;
    estado: EstadoMovimiento;
  }[];
}

export function armarPayloadImportacion(
  lectura: Extract<ResultadoLectura, { ok: true }>,
  archivo: string | null,
): PayloadImportacion {
  const fila = (m: MovimientoBanco) => ({
    fecha_hora: m.fechaHora,
    descripcion: m.descripcion,
    tipo: m.tipo,
    propio: m.propio,
    deposito: m.deposito,
    retiro: m.retiro,
    saldo: m.saldo,
    agencia: m.agencia,
    huella: m.huella,
    estado: m.estado,
  });
  return {
    banco: "caja_ica",
    cuenta: lectura.cuenta,
    archivo,
    periodo_desde: lectura.periodo?.desde ?? null,
    periodo_hasta: lectura.periodo?.hasta ?? null,
    filas: lectura.movimientos.map(fila),
  };
}

export interface ResumenImportacion {
  importId: string;
  filas: number;
  nuevos: number;
  duplicados: number;
}

export function importarEstadoCuenta(client: RpcClient, payload: PayloadImportacion) {
  return llamar<ResumenImportacion>(client, "import_bank_statement", { p_payload: payload }, (d) => {
    const r = (d ?? {}) as Record<string, unknown>;
    return {
      importId: String(r.import_id ?? ""),
      filas: Number(r.filas ?? 0),
      nuevos: Number(r.nuevos ?? 0),
      duplicados: Number(r.duplicados ?? 0),
    };
  });
}

const LOTE = 500;

/**
 * Guarda el resultado de la conciliación automática. Solo envía lo que cambia
 * algo ("conciliado" y "revisar"); lo que sigue "por conciliar" ya está así.
 * Por tandas de 500 (cada tanda es todo o nada en la base).
 */
export async function guardarConciliacion(client: RpcClient, resultados: readonly ResultadoConciliacion[]): Promise<ResultadoRpc<number>> {
  const items = resultados
    .filter((r) => r.estado !== "por_conciliar")
    .map((r) => ({ movement_id: r.movementId, estado: r.estado, payment_id: r.paymentId }));
  let total = 0;
  for (let i = 0; i < items.length; i += LOTE) {
    const r = await llamar(client, "set_movement_matches", { p_items: items.slice(i, i + LOTE) }, (d) => Number(d ?? 0));
    if (!r.ok) return r;
    total += r.data;
  }
  return { ok: true, data: total };
}

export function marcarMovimiento(
  client: RpcClient,
  a: { movementId: string; estado: EstadoMovimiento; paymentId?: string | null; nota?: string | null },
) {
  return llamar<void>(
    client,
    "set_movement_match",
    { p_movement_id: a.movementId, p_estado: a.estado, p_payment_id: a.paymentId ?? null, p_nota: a.nota ?? null },
    () => undefined,
  );
}
