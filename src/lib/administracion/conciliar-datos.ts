// Conciliación automática de un mes ya cargado: cruza los depósitos con los
// pagos del ERP (conciliacion.ts) y guarda el resultado por el RPC de la 093.
// No crea ni cambia pagos: solo enlaza movimientos del banco con pagos que ya
// existen (la lógica de 084 no se toca).

import type { RpcClient } from "@/lib/payment-plans/rpc";

import { conciliar } from "./conciliacion";
import { guardarConciliacion, type ResultadoRpc } from "./rpc";
import type { MovimientoGuardado, PagoVista } from "./tipos";

export interface ResumenConciliacion {
  conciliados: number;
  revisar: number;
}

export async function conciliarDatos(
  client: RpcClient,
  datos: { movimientos: readonly MovimientoGuardado[]; pagos: readonly PagoVista[] },
): Promise<ResultadoRpc<ResumenConciliacion>> {
  const resultados = conciliar(
    datos.movimientos.map((m) => ({ id: m.id, fecha: m.fecha, deposito: m.deposito, estado: m.estado, paymentId: m.paymentId })),
    datos.pagos,
  );
  // Un movimiento que ya estaba "revisar" y sigue igual no necesita escribirse de nuevo.
  const previo = new Map(datos.movimientos.map((m) => [m.id, m.estado]));
  const cambios = resultados.filter((r) => !(r.estado === "revisar" && previo.get(r.movementId) === "revisar"));
  const guardado = await guardarConciliacion(client, cambios);
  if (!guardado.ok) return guardado;
  return {
    ok: true,
    data: {
      conciliados: resultados.filter((r) => r.estado === "conciliado").length,
      revisar: resultados.filter((r) => r.estado === "revisar").length,
    },
  };
}
