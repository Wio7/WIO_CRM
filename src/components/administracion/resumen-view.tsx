"use client";

// Resumen de Administración: tarjeta vino con los abonos del mes, por tipo,
// comisiones y cuántos faltan por conciliar. La usan la app y la demo.

import Link from "next/link";

import { dinero } from "@/lib/cobranzas/dinero";
import { ETIQUETA_TIPO, type Resumen } from "@/lib/administracion/estado-cuenta";
import { nombreMes } from "@/lib/administracion/formato";

import { SelectorMes } from "./piezas";

interface Props {
  mes: string;
  /** Sin `onMes` (demo) el mes queda fijo. */
  onMes?: (mes: string) => void;
  resumen: Resumen;
  faltaConciliar: number;
  /** El mes no tiene movimientos guardados. */
  vacio: boolean;
  /** Dónde se sube el estado de cuenta. */
  hrefEstado: string;
  hrefPorValidar: string;
  mesMaximo?: string;
}

const TIPOS_ABONO = ["convenio", "interbancaria", "app", "efectivo", "otro"] as const;

export function ResumenView({ mes, onMes, resumen, faltaConciliar, vacio, hrefEstado, hrefPorValidar, mesMaximo }: Props) {
  const nAbonos = TIPOS_ABONO.reduce((n, t) => n + resumen.porTipo[t].n, 0);
  const propios = Math.round((resumen.totalDepositos - resumen.abonos) * 100) / 100;

  return (
    <div className="space-y-5">
      <SelectorMes mes={mes} onMes={onMes} hasta={mesMaximo} />

      <section className="gcard-hero" aria-label={`Abonos de ${nombreMes(mes)}`}>
        <p className="gcard-hero-label">Abonos de {nombreMes(mes)}</p>
        <p className="gcard-hero-value">{vacio ? "—" : dinero(resumen.abonos, "PEN")}</p>
        <p className="gcard-hero-sub">
          {vacio ? "Aún no hay estado de cuenta de este mes" : `${nAbonos} depósitos en la Caja Ica`}
        </p>
        <div className="gcard-hero-grid gcard-hero-grid--par">
          {(["convenio", "interbancaria", "app", "efectivo"] as const).map((t) => (
            <div key={t} className="gcard-mini">
              <span className="gcard-mini-label">{ETIQUETA_TIPO[t]} · {resumen.porTipo[t].n}</span>
              <span className="gcard-mini-value block">{dinero(resumen.porTipo[t].monto, "PEN")}</span>
            </div>
          ))}
          <div className="gcard-mini">
            <span className="gcard-mini-label">Otros depósitos · {resumen.porTipo.otro.n}</span>
            <span className="gcard-mini-value block">{dinero(resumen.porTipo.otro.monto, "PEN")}</span>
          </div>
          <div className="gcard-mini">
            <span className="gcard-mini-label">Traspasos propios</span>
            <span className="gcard-mini-value block">{dinero(propios, "PEN")}</span>
          </div>
          <div className="gcard-mini">
            <span className="gcard-mini-label">Comisiones (las paga la empresa)</span>
            <span className="gcard-mini-value block">{dinero(resumen.comisiones.monto, "PEN")}</span>
          </div>
          <div className={`gcard-mini ${faltaConciliar > 0 ? "gcard-mini--aviso" : ""}`}>
            <span className="gcard-mini-label">Falta conciliar</span>
            <span className="gcard-mini-value block">{faltaConciliar}</span>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap gap-2">
        <Link href={hrefEstado} className="gbtn">
          {vacio ? "Subir el estado de cuenta" : "Ver el estado de cuenta"}
        </Link>
        {faltaConciliar > 0 && (
          <Link href={hrefPorValidar} className="gbtn-line">
            Revisar {faltaConciliar} por validar
          </Link>
        )}
      </div>

      <div className="gsoon">
        <p className="gsoon-title">Próximamente</p>
        Contratos en firma de gerencia, legalizaciones (S/ 35) y cartas notariales por enviar. Llegarán cuando el
        expediente del cliente pase de un área a otra.
      </div>
    </div>
  );
}
