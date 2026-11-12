"use client";

// Piezas comunes de las pantallas de Administración (app y demo).

import { ChevronLeft, ChevronRight } from "lucide-react";

import type { EstadoMovimiento, TipoMovimiento } from "@/lib/administracion/estado-cuenta";
import { ETIQUETA_TIPO } from "@/lib/administracion/estado-cuenta";
import { nombreMes, sumarMes } from "@/lib/administracion/formato";

const ESTADO: Record<EstadoMovimiento, { etiqueta: string; clase: string }> = {
  por_conciliar: { etiqueta: "Por conciliar", clase: "gchip gchip-1-30" },
  conciliado: { etiqueta: "Conciliado", clase: "gchip gchip-ok" },
  no_es_cuota: { etiqueta: "No es cuota", clase: "gchip gchip-neutral" },
  revisar: { etiqueta: "Revisar", clase: "gchip gchip-61-90" },
};

export function ChipEstado({ estado }: { estado: EstadoMovimiento }) {
  const e = ESTADO[estado];
  return <span className={e.clase}>{e.etiqueta}</span>;
}

export function ChipTipo({ tipo }: { tipo: TipoMovimiento }) {
  return <span className="gchip gchip-neutral">{ETIQUETA_TIPO[tipo]}</span>;
}

export const ETIQUETA_ESTADO: Record<EstadoMovimiento, string> = {
  por_conciliar: ESTADO.por_conciliar.etiqueta,
  conciliado: ESTADO.conciliado.etiqueta,
  no_es_cuota: ESTADO.no_es_cuota.etiqueta,
  revisar: ESTADO.revisar.etiqueta,
};

/** Selector de mes con flechas. Sin `onMes` solo muestra el nombre. */
export function SelectorMes({ mes, onMes, hasta }: { mes: string; onMes?: (m: string) => void; hasta?: string }) {
  return (
    <div className="gmes">
      {onMes ? (
        <button type="button" className="gbtn-line" aria-label="Mes anterior" onClick={() => onMes(sumarMes(mes, -1))}>
          <ChevronLeft size={16} />
        </button>
      ) : <span />}
      <span className="gmes-nombre">{nombreMes(mes)}</span>
      {onMes ? (
        <button type="button" className="gbtn-line" aria-label="Mes siguiente" disabled={hasta !== undefined && mes >= hasta} onClick={() => onMes(sumarMes(mes, 1))}>
          <ChevronRight size={16} />
        </button>
      ) : <span />}
    </div>
  );
}

export function Aviso({ tipo = "aviso", children }: { tipo?: "aviso" | "error" | "ok"; children: React.ReactNode }) {
  const clase = tipo === "error" ? "gnotice gnotice--error" : tipo === "ok" ? "gnotice gnotice--ok" : "gnotice";
  return (
    <p role={tipo === "error" ? "alert" : "status"} className={clase}>
      {children}
    </p>
  );
}
