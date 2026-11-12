// Lectura de los movimientos del banco y de los pagos del ERP de un mes.
// Solo lee (las escrituras van por los RPC de rpc.ts). Si las tablas de la 093
// no existen, avisa con `sin093` en vez de fallar.

import { createClient } from "@/lib/supabase/client";

import { rangoMes, sumarDias } from "./formato";
import { aMovimiento, aPago, SELECT_MOVIMIENTOS, SELECT_PAGOS, type FilaMovimiento, type FilaPago, type MovimientoGuardado, type PagoVista } from "./tipos";

type Cliente = ReturnType<typeof createClient>;

const PAGINA = 1000;
/** Margen de días a cada lado del mes para pagos que caen cerca del borde (la conciliación mira ±2 días). */
const MARGEN_DIAS = 3;

export interface DatosMes {
  movimientos: MovimientoGuardado[];
  pagos: PagoVista[];
  /** true = la migración 093 (o la 084) no está aplicada en esta base. */
  sin093: boolean;
}

const tablaFalta = (code?: string) => code === "42P01" || code === "PGRST205";

export async function cargarMes(supabase: Cliente, mes: string): Promise<DatosMes | { error: string }> {
  const { desde, hasta } = rangoMes(mes);

  const movimientos: MovimientoGuardado[] = [];
  for (let from = 0; ; from += PAGINA) {
    const { data, error } = await supabase
      .from("bank_statement_movements")
      .select(SELECT_MOVIMIENTOS)
      .gte("fecha", desde)
      .lte("fecha", hasta)
      .order("fecha_hora", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGINA - 1);
    if (error) {
      if (tablaFalta(error.code)) return { movimientos: [], pagos: [], sin093: true };
      return { error: error.message };
    }
    movimientos.push(...((data ?? []) as unknown as FilaMovimiento[]).map(aMovimiento));
    if (!data || data.length < PAGINA) break;
  }

  const pagos: PagoVista[] = [];
  for (let from = 0; ; from += PAGINA) {
    const { data, error } = await supabase
      .from("installment_payments")
      .select(SELECT_PAGOS)
      .gte("paid_on", sumarDias(desde, -MARGEN_DIAS))
      .lte("paid_on", sumarDias(hasta, MARGEN_DIAS))
      .order("paid_on", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGINA - 1);
    if (error) {
      if (tablaFalta(error.code)) return { movimientos, pagos: [], sin093: true };
      return { error: error.message };
    }
    pagos.push(...((data ?? []) as unknown as FilaPago[]).map(aPago));
    if (!data || data.length < PAGINA) break;
  }
  return { movimientos, pagos, sin093: false };
}

/** Mes (aaaa-mm) del último movimiento guardado, o null si no hay ninguno. */
export async function ultimoMesConDatos(supabase: Cliente): Promise<string | null> {
  const { data } = await supabase.from("bank_statement_movements").select("fecha").order("fecha", { ascending: false }).limit(1);
  const fecha = (data as { fecha: string }[] | null)?.[0]?.fecha;
  return fecha ? fecha.slice(0, 7) : null;
}
