"use client";

// Movimientos del estado de cuenta: filtro por tipo y estado; en laptop una
// tabla y en celular una tarjeta por movimiento. La usan la app y la demo.

import { useMemo, useState } from "react";

import { dinero } from "@/lib/cobranzas/dinero";
import { ETIQUETA_TIPO, TIPOS, type EstadoMovimiento, type TipoMovimiento } from "@/lib/administracion/estado-cuenta";
import { fechaHoraLima } from "@/lib/administracion/formato";
import type { MovimientoGuardado } from "@/lib/administracion/tipos";

import { ChipEstado, ChipTipo, ETIQUETA_ESTADO } from "./piezas";

const ESTADOS: EstadoMovimiento[] = ["por_conciliar", "revisar", "conciliado", "no_es_cuota"];

export function MovimientosView({ movimientos }: { movimientos: MovimientoGuardado[] }) {
  const [tipo, setTipo] = useState<TipoMovimiento | "todos">("todos");
  const [estado, setEstado] = useState<EstadoMovimiento | "todos">("todos");
  const visibles = useMemo(
    () => movimientos.filter((m) => (tipo === "todos" || m.tipo === tipo) && (estado === "todos" || m.estado === estado)),
    [movimientos, tipo, estado],
  );

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="gpills" role="group" aria-label="Filtrar por tipo">
          <button type="button" className="gpill" aria-pressed={tipo === "todos"} onClick={() => setTipo("todos")}>Todos los tipos</button>
          {TIPOS.map((t) => (
            <button key={t} type="button" className="gpill" aria-pressed={tipo === t} onClick={() => setTipo(tipo === t ? "todos" : t)}>
              {ETIQUETA_TIPO[t]}
            </button>
          ))}
        </div>
        <div className="gpills" role="group" aria-label="Filtrar por estado">
          <button type="button" className="gpill" aria-pressed={estado === "todos"} onClick={() => setEstado("todos")}>Todos los estados</button>
          {ESTADOS.map((e) => (
            <button key={e} type="button" className="gpill" aria-pressed={estado === e} onClick={() => setEstado(estado === e ? "todos" : e)}>
              {ETIQUETA_ESTADO[e]}
            </button>
          ))}
        </div>
      </div>

      <p className="text-sm" style={{ color: "var(--ink-3)" }}>
        {visibles.length} de {movimientos.length} movimientos
      </p>

      {visibles.length === 0 ? (
        <p className="py-12 text-center text-sm" style={{ color: "var(--ink-3)" }}>No hay movimientos con ese filtro.</p>
      ) : (
        <>
          {/* Laptop: tabla */}
          <div className="gpanel hidden md:block">
            <table className="gtable">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Descripción</th>
                  <th>Tipo</th>
                  <th style={{ textAlign: "right" }}>Depósito</th>
                  <th style={{ textAlign: "right" }}>Retiro</th>
                  <th style={{ textAlign: "right" }}>Saldo</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((m) => (
                  <tr key={m.id}>
                    <td className="whitespace-nowrap">{fechaHoraLima(m.fechaHora)}</td>
                    <td>
                      {m.descripcion}
                      {m.agencia && <span className="block text-xs" style={{ color: "var(--ink-3)" }}>{m.agencia}</span>}
                      {m.propio && <span className="block text-xs" style={{ color: "var(--ink-3)" }}>Traspaso entre cuentas propias</span>}
                    </td>
                    <td><ChipTipo tipo={m.tipo} /></td>
                    <td style={{ textAlign: "right" }} className="font-semibold">{m.deposito > 0 ? dinero(m.deposito, "PEN") : ""}</td>
                    <td style={{ textAlign: "right" }}>{m.retiro > 0 ? dinero(-m.retiro, "PEN") : ""}</td>
                    <td style={{ textAlign: "right", color: "var(--ink-3)" }}>{m.saldo === null ? "" : dinero(m.saldo, "PEN")}</td>
                    <td><ChipEstado estado={m.estado} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Celular: tarjetas */}
          <ul className="space-y-3 md:hidden">
            {visibles.map((m) => (
              <li key={m.id} className="gitem">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-lg font-semibold">
                      {m.deposito > 0 ? dinero(m.deposito, "PEN") : dinero(-m.retiro, "PEN")}
                    </p>
                    <p className="text-sm">{m.descripcion}</p>
                    <p className="text-xs" style={{ color: "var(--ink-3)" }}>
                      {fechaHoraLima(m.fechaHora)}{m.agencia ? ` · ${m.agencia}` : ""}
                    </p>
                  </div>
                  <ChipEstado estado={m.estado} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <ChipTipo tipo={m.tipo} />
                  {m.propio && <span className="text-xs" style={{ color: "var(--ink-3)" }}>Traspaso entre cuentas propias</span>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
