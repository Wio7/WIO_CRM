"use client";

// Por validar: depósitos del banco sin pago en el ERP y pagos del ERP sin
// depósito. Enlazar y "No es una cuota" van por los RPC de la 093.

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useEstadoCuenta } from "@/hooks/use-estado-cuenta";
import { marcarMovimiento } from "@/lib/administracion/rpc";
import { Aviso, SelectorMes } from "@/components/administracion/piezas";
import { PorValidarView } from "@/components/administracion/por-validar-view";

export default function PorValidarPagina() {
  const { supabase, mes, setMes, datos, error, cargando, recargar, mesMaximo } = useEstadoCuenta();
  const [ocupado, setOcupado] = useState<string | null>(null);

  async function aplicar(id: string, a: Parameters<typeof marcarMovimiento>[1], ok: string) {
    setOcupado(id);
    const r = await marcarMovimiento(supabase, a);
    setOcupado(null);
    if (!r.ok) toast.error(r.message);
    else toast.success(ok);
    recargar();
  }

  return (
    <div className="space-y-5">
      {datos?.sin093 && <Aviso>Falta aplicar la migración 093 (estado de cuenta del banco) en Supabase.</Aviso>}
      {mes && <SelectorMes mes={mes} onMes={setMes} hasta={mesMaximo} />}
      {error && <Aviso tipo="error">No se pudo cargar: {error}</Aviso>}
      {cargando && !error ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : datos ? (
        <PorValidarView
          movimientos={datos.movimientos}
          pagos={datos.pagos}
          hrefVouchers="/administracion/vouchers"
          acciones={{
            ocupado,
            onEnlazar: (m, pagoId) => aplicar(m.id, { movementId: m.id, estado: "conciliado", paymentId: pagoId }, "Depósito enlazado con el pago"),
            onNoEsCuota: (m) => aplicar(m.id, { movementId: m.id, estado: "no_es_cuota" }, "Marcado como no es una cuota"),
          }}
        />
      ) : null}
    </div>
  );
}
