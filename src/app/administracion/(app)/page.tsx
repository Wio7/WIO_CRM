"use client";

// Resumen de Administración: abonos del mes de la Caja Ica, por tipo,
// comisiones y cuántos faltan por conciliar.

import { useMemo } from "react";
import { Loader2 } from "lucide-react";

import { useEstadoCuenta } from "@/hooks/use-estado-cuenta";
import { resumirMovimientos } from "@/lib/administracion/estado-cuenta";
import { Aviso } from "@/components/administracion/piezas";
import { ResumenView } from "@/components/administracion/resumen-view";

export default function ResumenPagina() {
  const { mes, setMes, datos, error, cargando, mesMaximo } = useEstadoCuenta();
  const resumen = useMemo(() => resumirMovimientos(datos?.movimientos ?? []), [datos]);
  const falta = useMemo(
    () => (datos?.movimientos ?? []).filter((m) => m.deposito > 0 && (m.estado === "por_conciliar" || m.estado === "revisar")).length,
    [datos],
  );

  if (!mes) return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  return (
    <div className="space-y-4">
      {datos?.sin093 && <Aviso>Falta aplicar la migración 093 (estado de cuenta del banco) en Supabase.</Aviso>}
      {error && <Aviso tipo="error">No se pudo cargar: {error}</Aviso>}
      {cargando && !error ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : (
        <ResumenView
          mes={mes}
          onMes={setMes}
          mesMaximo={mesMaximo}
          resumen={resumen}
          faltaConciliar={falta}
          vacio={(datos?.movimientos.length ?? 0) === 0}
          hrefEstado="/administracion/estado-de-cuenta"
          hrefPorValidar="/administracion/por-validar"
        />
      )}
    </div>
  );
}
