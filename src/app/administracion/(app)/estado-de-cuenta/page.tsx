"use client";

// Estado de cuenta de la Caja Ica: subir el .xls y ver los movimientos del mes
// con filtro por tipo y estado.

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useEstadoCuenta } from "@/hooks/use-estado-cuenta";
import { conciliarDatos } from "@/lib/administracion/conciliar-datos";
import { Aviso, SelectorMes } from "@/components/administracion/piezas";
import { MovimientosView } from "@/components/administracion/movimientos-view";
import { SubirEstado } from "@/components/administracion/subir-estado";

export default function EstadoDeCuentaPagina() {
  const { supabase, mes, setMes, datos, error, cargando, recargar, mesMaximo } = useEstadoCuenta();
  const [conciliando, setConciliando] = useState(false);

  async function conciliarAhora() {
    if (!datos) return;
    setConciliando(true);
    const r = await conciliarDatos(supabase, datos);
    setConciliando(false);
    if (!r.ok) toast.error(r.message);
    else toast.success(`Conciliados con el ERP: ${r.data.conciliados}; por revisar: ${r.data.revisar}.`);
    recargar();
  }

  return (
    <div className="space-y-5">
      {datos?.sin093 && <Aviso>Falta aplicar la migración 093 (estado de cuenta del banco) en Supabase: sin ella no se puede importar.</Aviso>}
      <SubirEstado supabase={supabase} onImportado={(m) => { setMes(m); recargar(); }} />
      {mes && <SelectorMes mes={mes} onMes={setMes} hasta={mesMaximo} />}
      {error && <Aviso tipo="error">No se pudo cargar: {error}</Aviso>}
      {cargando && !error ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : datos && datos.movimientos.length === 0 ? (
        <p className="py-12 text-center text-sm" style={{ color: "var(--ink-3)" }}>
          No hay movimientos guardados en este mes. Sube el estado de cuenta para verlos aquí.
        </p>
      ) : datos ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm" style={{ color: "var(--ink-3)" }}>
              Los depósitos se cruzan con los pagos del ERP por monto y fecha (±2 días).
            </p>
            <button type="button" className="gbtn-line" disabled={conciliando} onClick={conciliarAhora}>
              {conciliando && <Loader2 size={14} className="animate-spin" />} Conciliar con el ERP
            </button>
          </div>
          <MovimientosView movimientos={datos.movimientos} />
        </>
      ) : null}
    </div>
  );
}
