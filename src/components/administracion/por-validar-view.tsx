"use client";

// Por validar: depósitos del banco sin pago en el ERP y pagos del ERP sin
// depósito. Enlazar un depósito con un pago y marcar "No es cuota" van por los
// RPC de la 093; la confirmación de pagos de 084 no cambia (los vouchers se
// aprueban en su pantalla de siempre). La usan la app y la demo (sin acciones).

import { useMemo } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import { dinero } from "@/lib/cobranzas/dinero";
import { fechaLima } from "@/lib/collections";
import { conciliar, resumenPorValidar } from "@/lib/administracion/conciliacion";
import { fechaHoraLima } from "@/lib/administracion/formato";
import type { MovimientoGuardado, PagoVista } from "@/lib/administracion/tipos";

import { ChipEstado, ChipTipo } from "./piezas";

export interface AccionesPorValidar {
  ocupado: string | null;
  onEnlazar: (movimiento: MovimientoGuardado, pagoId: string) => void;
  onNoEsCuota: (movimiento: MovimientoGuardado) => void;
}

interface Props {
  movimientos: MovimientoGuardado[];
  pagos: PagoVista[];
  /** Sin acciones (demo) los botones quedan apagados. */
  acciones?: AccionesPorValidar;
  /** Pantalla de vouchers por confirmar (084); solo en la app. */
  hrefVouchers?: string;
}

const textoPago = (p: PagoVista) => [p.cliente ?? "Cliente sin nombre", p.lote ? `Lote ${p.lote}` : null, p.cuota ? `cuota ${p.cuota}` : null].filter(Boolean).join(" · ");

export function PorValidarView({ movimientos, pagos, acciones, hrefVouchers }: Props) {
  const conciliables = useMemo(
    () => movimientos.map((m) => ({ id: m.id, fecha: m.fecha, deposito: m.deposito, estado: m.estado, paymentId: m.paymentId })),
    [movimientos],
  );
  const { depositosSinPago, pagosSinDeposito } = useMemo(() => resumenPorValidar(conciliables, pagos), [conciliables, pagos]);
  const candidatos = useMemo(() => new Map(conciliar(conciliables, pagos).map((r) => [r.movementId, r.candidatos])), [conciliables, pagos]);
  const porId = useMemo(() => new Map(movimientos.map((m) => [m.id, m])), [movimientos]);
  const pagoPorId = useMemo(() => new Map(pagos.map((p) => [p.id, p])), [pagos]);
  const sinDeposito = depositosSinPago.map((d) => porId.get(d.id)!).filter(Boolean);
  const apagado = !acciones;

  return (
    <div className="space-y-8">
      {hrefVouchers && (
        <div className="gitem flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-semibold">Vouchers de clientes por confirmar</p>
            <p className="text-sm" style={{ color: "var(--ink-3)" }}>Se aprueban o rechazan como siempre; al aprobar queda el pago en el ERP.</p>
          </div>
          <Link href={hrefVouchers} className="gbtn-line">Abrir vouchers</Link>
        </div>
      )}

      <section className="space-y-3" aria-labelledby="pv-depositos">
        <h2 id="pv-depositos" className="text-xl">Depósitos sin pago en el ERP <span className="text-base" style={{ color: "var(--ink-3)" }}>({sinDeposito.length})</span></h2>
        <p className="text-sm" style={{ color: "var(--ink-3)" }}>
          El estado de cuenta no trae el código del cliente: se cruza por monto y fecha (±2 días). Si hay un solo pago posible, se concilia solo; si hay varios, lo eliges tú.
        </p>
        {sinDeposito.length === 0 ? (
          <p className="py-8 text-center text-sm" style={{ color: "var(--ink-3)" }}>No hay depósitos pendientes.</p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {sinDeposito.map((m) => {
              const cand = (candidatos.get(m.id) ?? []).map((id) => pagoPorId.get(id)).filter((p): p is PagoVista => Boolean(p));
              return (
                <li key={m.id} className="gitem">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-lg font-semibold">{dinero(m.deposito, "PEN")}</p>
                      <p className="text-sm">{m.descripcion}</p>
                      <p className="text-xs" style={{ color: "var(--ink-3)" }}>{fechaHoraLima(m.fechaHora)}{m.agencia ? ` · ${m.agencia}` : ""}</p>
                    </div>
                    <ChipEstado estado={m.estado} />
                  </div>
                  <div className="mt-2"><ChipTipo tipo={m.tipo} /></div>
                  {cand.length > 0 && (
                    <div className="mt-3 space-y-2">
                      <p className="text-xs font-semibold" style={{ color: "var(--ink-3)" }}>
                        {cand.length === 1 ? "Un pago posible" : `${cand.length} pagos posibles: elige el correcto`}
                      </p>
                      {cand.map((p) => (
                        <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border p-2" style={{ borderColor: "var(--line)" }}>
                          <div className="min-w-0 text-sm">
                            {textoPago(p)}
                            <span className="block text-xs" style={{ color: "var(--ink-3)" }}>pagó el {fechaLima(p.paidOn)}</span>
                          </div>
                          <button
                            type="button"
                            className="gbtn"
                            disabled={apagado || acciones?.ocupado !== null}
                            title={apagado ? "En la demostración no se guarda nada" : undefined}
                            onClick={() => acciones?.onEnlazar(m, p.id)}
                          >
                            {acciones?.ocupado === m.id && <Loader2 size={14} className="animate-spin" />} Enlazar
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mt-3">
                    <button
                      type="button"
                      className="gbtn-line"
                      disabled={apagado || acciones?.ocupado !== null}
                      title={apagado ? "En la demostración no se guarda nada" : undefined}
                      onClick={() => acciones?.onNoEsCuota(m)}
                    >
                      No es una cuota
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="pv-pagos">
        <h2 id="pv-pagos" className="text-xl">Pagos del ERP sin depósito <span className="text-base" style={{ color: "var(--ink-3)" }}>({pagosSinDeposito.length})</span></h2>
        <p className="text-sm" style={{ color: "var(--ink-3)" }}>
          Pagos ya registrados en el ERP que ningún depósito de este mes respalda todavía (puede que el banco aún no los traiga).
        </p>
        {pagosSinDeposito.length === 0 ? (
          <p className="py-8 text-center text-sm" style={{ color: "var(--ink-3)" }}>Todos los pagos tienen su depósito.</p>
        ) : (
          <>
            <div className="gpanel hidden md:block">
              <table className="gtable">
                <thead>
                  <tr><th>Cliente</th><th>Pagó el</th><th>Método</th><th style={{ textAlign: "right" }}>Monto</th></tr>
                </thead>
                <tbody>
                  {pagosSinDeposito.map((p) => {
                    const v = pagoPorId.get(p.id)!;
                    return (
                      <tr key={p.id}>
                        <td>{textoPago(v)}</td>
                        <td>{fechaLima(v.paidOn)}</td>
                        <td>{v.metodo ?? "—"}</td>
                        <td style={{ textAlign: "right" }} className="font-semibold">{dinero(v.amount, v.moneda)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ul className="space-y-3 md:hidden">
              {pagosSinDeposito.map((p) => {
                const v = pagoPorId.get(p.id)!;
                return (
                  <li key={p.id} className="gitem">
                    <p className="text-lg font-semibold">{dinero(v.amount, v.moneda)}</p>
                    <p className="text-sm">{textoPago(v)}</p>
                    <p className="text-xs" style={{ color: "var(--ink-3)" }}>Pagó el {fechaLima(v.paidOn)}{v.metodo ? ` · ${v.metodo}` : ""}</p>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
