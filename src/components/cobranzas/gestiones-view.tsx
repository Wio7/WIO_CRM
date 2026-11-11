"use client";

// Sección "Gestiones" de la app de Cobranzas: las llamadas, visitas y
// promesas que se registraron, con foco en las promesas de pago. Lee la misma
// tabla (collection_actions, 082) y usa las mismas reglas que la lista de morosos.
// Laptop: tabla. Celular: tarjetas.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ClipboardList, Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { fechaLima, hoyLima } from "@/lib/collections";
import { channelLabel, isMissingTable, resultLabel, type CollectionAction } from "@/lib/collection-actions";
import { ordenarGestiones, resumenGestiones, type VistaGestiones } from "@/lib/cobranzas/gestiones";
import { cn } from "@/lib/utils";
import { useCollectionsPaths } from "@/components/collections/base-path";

type Fila = CollectionAction & { contact: { id: string; name: string | null; phone: string | null } | null };

const LIMITE = 500;

const VISTAS: ReadonlyArray<{ key: VistaGestiones; label: string }> = [
  { key: "vencidas", label: "Promesas vencidas" },
  { key: "vigentes", label: "Promesas por cumplir" },
  { key: "recientes", label: "Recientes" },
];

export function GestionesView() {
  const paths = useCollectionsPaths();
  const hoy = useMemo(() => hoyLima(), []);
  const [filas, setFilas] = useState<Fila[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [falta082, setFalta082] = useState(false);
  const [vista, setVista] = useState<VistaGestiones>("vencidas");

  useEffect(() => {
    let cancelled = false;
    createClient()
      .from("collection_actions")
      .select(
        "id, contact_id, plan_id, channel, result, promise_date, promise_amount, note, created_by, created_at, contact:contacts(id, name, phone)",
      )
      .order("created_at", { ascending: false })
      .limit(LIMITE)
      .then(({ data, error: e }) => {
        if (cancelled) return;
        if (e) {
          if (isMissingTable(e)) setFalta082(true);
          else setError(e.message);
        } else {
          setFilas((data ?? []) as unknown as Fila[]);
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const resumen = useMemo(() => resumenGestiones(filas, hoy), [filas, hoy]);
  const visibles = useMemo(() => ordenarGestiones(filas, vista, hoy), [filas, vista, hoy]);
  const cuenta = (k: VistaGestiones) => (k === "vencidas" ? resumen.vencidas : k === "vigentes" ? resumen.vigentes : filas.length);
  const cliente = (f: Fila) => f.contact?.name ?? "Cliente sin nombre";
  const enlace = (f: Fila) => (paths.cliente ? paths.cliente(f.contact_id) : paths.base);
  const monto = (f: Fila) => (f.promise_amount != null ? `monto ${Number(f.promise_amount).toLocaleString("es-PE", { minimumFractionDigits: 2 })}` : null);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ClipboardList className="h-6 w-6 text-primary" /> Gestiones
        </h1>
        <p className="text-sm text-muted-foreground">
          Lo que se hizo para cobrar y las promesas de pago, al {fechaLima(hoy)}.
        </p>
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Vista de gestiones">
        {VISTAS.map((v) => (
          <button
            key={v.key}
            type="button"
            role="tab"
            aria-selected={vista === v.key}
            onClick={() => setVista(v.key)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm",
              vista === v.key ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted",
            )}
          >
            {v.label} <span className="ml-1 font-semibold">{loading ? "" : cuenta(v.key)}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm">No se pudo cargar: {error}</p>
      ) : falta082 ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          Para ver gestiones falta aplicar la migración 082 (gestiones de cobranza) en Supabase.
        </p>
      ) : visibles.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {vista === "recientes" ? "Todavía no hay gestiones registradas." : "Nada en esta vista."}
        </p>
      ) : (
        <>
          {/* Laptop: tabla */}
          <div className="hidden overflow-hidden rounded-xl border border-border md:block">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Cliente</th>
                  <th className="px-3 py-2 font-medium">Gestión</th>
                  <th className="px-3 py-2 font-medium">Promesa</th>
                  <th className="px-3 py-2 font-medium">Nota</th>
                  <th className="px-3 py-2 font-medium">Fecha</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((f) => (
                  <tr key={f.id} className="border-t border-border align-top hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <Link href={enlace(f)} className="font-medium hover:underline">{cliente(f)}</Link>
                      <span className="block text-xs text-muted-foreground">{f.contact?.phone ?? "Sin teléfono"}</span>
                    </td>
                    <td className="px-3 py-2">
                      {resultLabel(f.result)}
                      <span className="block text-xs text-muted-foreground">{channelLabel(f.channel)}</span>
                    </td>
                    <td className="px-3 py-2">
                      {f.promise_date ? (
                        <>
                          {fechaLima(f.promise_date)}
                          {monto(f) && <span className="block text-xs text-muted-foreground">{monto(f)}</span>}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="max-w-xs px-3 py-2 text-xs text-muted-foreground">{f.note ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{fechaLima(f.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Celular: tarjetas */}
          <ul className="space-y-2 md:hidden">
            {visibles.map((f) => (
              <li key={f.id} className="rounded-xl border border-border bg-card p-3">
                <div className="flex items-start justify-between gap-2">
                  <Link href={enlace(f)} className="font-medium">{cliente(f)}</Link>
                  <span className="shrink-0 text-xs text-muted-foreground">{fechaLima(f.created_at)}</span>
                </div>
                <p className="mt-1 text-sm">
                  {resultLabel(f.result)} · <span className="text-muted-foreground">{channelLabel(f.channel)}</span>
                </p>
                {f.promise_date && (
                  <p className="text-sm">
                    Promete {fechaLima(f.promise_date)}
                    {monto(f) ? ` · ${monto(f)}` : ""}
                  </p>
                )}
                {f.note && <p className="mt-1 text-xs text-muted-foreground">{f.note}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
