"use client";

// Bandeja compartida de traspasos (migración 085): "Te enviaron" y "Enviados".
// Laptop: tabla ancha. Celular: tarjetas apiladas.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/currency";
import { HANDOFF_KINDS, TOPIC_LABELS, kindsTo, type HandoffModule } from "@/lib/handoffs/kinds";
import {
  acceptHandoff,
  listHandoffs,
  returnHandoff,
  type HandoffBox,
  type HandoffRow,
} from "@/lib/handoffs/rpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const AREA: Record<HandoffModule, string> = { cobranzas: "Cobranzas", legal: "Legal", postventa: "Postventa", administracion: "Administración" };

const fechaHora = (iso: string) =>
  new Date(iso).toLocaleString("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const ESTADO: Record<string, { label: string; cls: string }> = {
  pendiente: { label: "Pendiente", cls: "bg-amber-500/15 text-amber-400" },
  aceptado: { label: "Aceptado", cls: "bg-emerald-500/15 text-emerald-400" },
  devuelto: { label: "Devuelto", cls: "bg-red-500/15 text-red-400" },
};

function resumen(h: HandoffRow): string {
  const s = h.summary;
  if (!s) return "—";
  const partes: string[] = [];
  if (s.cliente) partes.push(s.cliente);
  if (s.lote) partes.push(s.lote);
  if (s.proyecto) partes.push(s.proyecto);
  if (h.kind === "pase_legal") {
    // La moneda es la del plan; sin ella, el default de payment_plans.currency (043).
    if (s.deuda_total != null) partes.push(`Deuda ${formatCurrency(Number(s.deuda_total), s.moneda || "PEN")}`);
    const n = s.cuotas_vencidas;
    if (n != null) partes.push(`${n} cuota${n === 1 ? "" : "s"} vencida${n === 1 ? "" : "s"}`);
  }
  return partes.join(" · ") || "—";
}

function Estado({ h }: { h: HandoffRow }) {
  const e = ESTADO[h.status] ?? { label: h.status, cls: "bg-muted text-muted-foreground" };
  return <span className={cn("rounded-full px-2 py-0.5 text-xs", e.cls)}>{e.label}</span>;
}

function Detalle({ h, box }: { h: HandoffRow; box: HandoffBox }) {
  return (
    <>
      {h.topic && (
        <span className="block text-xs text-muted-foreground">Tema: {TOPIC_LABELS[h.topic] ?? h.topic}</span>
      )}
      {h.note && <span className="block text-xs">{h.note}</span>}
      {h.return_reason && <span className="block text-xs text-red-400">Devuelto: {h.return_reason}</span>}
      <span className="block text-xs text-muted-foreground">
        {box === "recibidos"
          ? `De ${h.sent_by_name ?? "—"}`
          : h.handled_by_name
            ? `Lo tiene ${h.handled_by_name}`
            : "Sin tomar"}
        {" · "}
        {fechaHora(h.created_at)}
      </span>
    </>
  );
}

export function HandoffInbox({ module }: { module: HandoffModule }) {
  // Un área que no recibe ningún tipo (cobranzas en F1) abre en "Enviados":
  // ahí ve lo que le devolvieron.
  const [box, setBox] = useState<HandoffBox>(() => (kindsTo(module).length === 0 ? "enviados" : "recibidos"));
  const [rows, setRows] = useState<HandoffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sin085, setSin085] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [devolver, setDevolver] = useState<HandoffRow | null>(null);
  const [motivo, setMotivo] = useState("");

  const [tick, setTick] = useState(0);
  const cargar = () => setTick((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    listHandoffs(createClient(), module, box).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setRows(r.data);
        setError(null);
      } else if (r.missing085) {
        setSin085(true);
      } else {
        setError(r.message);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [module, box, tick]);

  async function aceptar(h: HandoffRow) {
    setBusyId(h.id);
    const r = await acceptHandoff(createClient(), h.id);
    setBusyId(null);
    if (!r.ok) toast.error(r.message);
    else toast.success("Lo tomaste");
    // Si otra persona lo tomó primero ("Ya lo tomó"), recargar muestra su estado real.
    cargar();
  }

  async function confirmarDevolver() {
    if (!devolver) return;
    setBusyId(devolver.id);
    const r = await returnHandoff(createClient(), devolver.id, motivo);
    setBusyId(null);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    toast.success("Devuelto");
    setDevolver(null);
    setMotivo("");
    cargar();
  }

  if (sin085) {
    return (
      <p className="rounded-xl border border-border p-4 text-sm text-muted-foreground">
        Falta aplicar la migración 085 (conexiones entre áreas) en Supabase.
      </p>
    );
  }

  const acciones = (h: HandoffRow) =>
    box === "recibidos" && h.status === "pendiente" ? (
      <div className="flex justify-end gap-1.5">
        <Button size="sm" disabled={busyId === h.id} onClick={() => aceptar(h)}>
          {busyId === h.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Aceptar
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busyId === h.id}
          onClick={() => {
            setDevolver(h);
            setMotivo("");
          }}
        >
          Devolver
        </Button>
      </div>
    ) : null;

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(["recibidos", "enviados"] as HandoffBox[]).map((b) => (
          <Button key={b} size="sm" variant={box === b ? "default" : "outline"} onClick={() => {
              setLoading(true);
              setBox(b);
            }}>
            {b === "recibidos" ? "Te enviaron" : "Enviados"}
          </Button>
        ))}
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>
      )}
      {loading ? (
        <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
        </p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {box === "recibidos" ? "Nada pendiente por ahora." : "Todavía no enviaste nada."}
        </p>
      ) : (
        <>
          {/* Laptop: tabla */}
          <div className="hidden overflow-hidden rounded-xl border border-border md:block">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Tipo</th>
                  <th className="px-3 py-2 font-medium">Caso</th>
                  <th className="px-3 py-2 font-medium">Detalle</th>
                  <th className="px-3 py-2 font-medium">Estado</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => {
                  const def = HANDOFF_KINDS[h.kind];
                  return (
                    <tr key={h.id} className="border-t border-border align-top hover:bg-muted/30">
                      <td className="px-3 py-2">
                        {def?.button ?? h.kind}
                        {def && (
                          <span className="block text-xs text-muted-foreground">
                            {AREA[def.from]} → {AREA[def.to]}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">{resumen(h)}</td>
                      <td className="px-3 py-2">
                        <Detalle h={h} box={box} />
                      </td>
                      <td className="px-3 py-2">
                        <Estado h={h} />
                      </td>
                      <td className="px-3 py-2">{acciones(h)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Celular: tarjetas */}
          <ul className="space-y-2 md:hidden">
            {rows.map((h) => (
              <li key={h.id} className="rounded-xl border border-border bg-card p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">{HANDOFF_KINDS[h.kind]?.button ?? h.kind}</p>
                  <Estado h={h} />
                </div>
                <p className="mt-1 text-sm">{resumen(h)}</p>
                <div className="mt-1">
                  <Detalle h={h} box={box} />
                </div>
                <div className="mt-2">{acciones(h)}</div>
              </li>
            ))}
          </ul>
        </>
      )}

      <Dialog open={devolver !== null} onOpenChange={(o) => !o && busyId === null && setDevolver(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Devolver caso</DialogTitle>
            <DialogDescription>Cuéntale a quien lo envió por qué lo devuelves.</DialogDescription>
          </DialogHeader>
          <Textarea rows={3} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Motivo" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDevolver(null)}>
              Cancelar
            </Button>
            <Button onClick={confirmarDevolver} disabled={!motivo.trim() || busyId !== null}>
              {busyId !== null && <Loader2 className="h-4 w-4 animate-spin" />} Devolver
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
