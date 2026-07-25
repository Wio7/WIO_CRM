"use client";

import { useState, useEffect } from "react";
import type { Anexo02Data, CuotaRow, FinanciamientoTipo, LegalDocument } from "@/types";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Scale } from "lucide-react";
import { toast } from "sonner";

interface Anexo02FormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reservationId: string;
  defaultTotal: number;
  currency: string;
  existingDoc?: LegalDocument | null;
  onSaved: () => void;
}

function buildCuotas(count: number, saldo: number, startDate: Date): CuotaRow[] {
  const perCuota = count > 0 ? Math.round((saldo / count) * 100) / 100 : 0;
  return Array.from({ length: count }, (_, i) => {
    const fecha = new Date(startDate);
    fecha.setMonth(fecha.getMonth() + i + 1);
    return {
      numero: i + 1,
      fecha_limite: fecha.toISOString().slice(0, 10),
      monto: perCuota,
    };
  });
}

export function Anexo02Form({
  open,
  onOpenChange,
  reservationId,
  defaultTotal,
  currency,
  existingDoc,
  onSaved,
}: Anexo02FormProps) {
  const [precioTotal, setPrecioTotal] = useState(String(defaultTotal || ""));
  const [cuotaInicial, setCuotaInicial] = useState("0");
  const [tipoFinanciamiento, setTipoFinanciamiento] = useState<FinanciamientoTipo>("credito_directo");
  const [numCuotas, setNumCuotas] = useState("12");
  const [cuotas, setCuotas] = useState<CuotaRow[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (existingDoc) {
      const data = existingDoc.data as unknown as Anexo02Data;
      setPrecioTotal(String(data.precio_total ?? defaultTotal ?? ""));
      setCuotaInicial(String(data.cuota_inicial ?? 0));
      setTipoFinanciamiento(data.tipo_financiamiento ?? "credito_directo");
      setNumCuotas(String(data.cuotas?.length ?? 12));
      setCuotas(data.cuotas ?? []);
    } else {
      setPrecioTotal(String(defaultTotal || ""));
      setCuotaInicial("0");
      setTipoFinanciamiento("credito_directo");
      setNumCuotas("12");
      setCuotas([]);
    }
  }, [open, existingDoc, defaultTotal]);

  const total = parseFloat(precioTotal) || 0;
  const inicial = parseFloat(cuotaInicial) || 0;
  const saldo = total - inicial;
  const cuotasSum = cuotas.reduce((s, c) => s + (c.monto || 0), 0);
  const diff = Math.round((saldo - cuotasSum) * 100) / 100;
  const cuadra = Math.abs(diff) < 0.01;

  function generarCuotas() {
    const count = parseInt(numCuotas, 10) || 0;
    if (count <= 0) {
      toast.error("Ingresa un número de cuotas válido");
      return;
    }
    setCuotas(buildCuotas(count, saldo, new Date()));
  }

  function updateCuota(i: number, field: keyof CuotaRow, value: string) {
    setCuotas((prev) =>
      prev.map((c, idx) =>
        idx === i
          ? { ...c, [field]: field === "monto" ? parseFloat(value) || 0 : value }
          : c,
      ),
    );
  }

  function ajustarDiferencia() {
    if (cuotas.length === 0) return;
    setCuotas((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      next[next.length - 1] = {
        ...last,
        monto: Math.round((last.monto + diff) * 100) / 100,
      };
      return next;
    });
  }

  async function handleSave() {
    if (cuotas.length === 0) {
      toast.error("Genera el cronograma de cuotas primero");
      return;
    }
    if (!cuadra) {
      toast.error("La suma de cuotas no cuadra con el saldo a financiar. Ajusta la diferencia primero.");
      return;
    }
    setSaving(true);
    const payload: Anexo02Data = {
      precio_total: total,
      cuota_inicial: inicial,
      tipo_financiamiento: tipoFinanciamiento,
      cuotas,
    };

    try {
      const res = await fetch(`/api/reservations/${reservationId}/legal-documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc_type: "anexo_02", data: payload }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "No se pudo generar el Anexo 02");
        return;
      }
      toast.success("Anexo 02 generado");
      onOpenChange(false);
      onSaved();
    } catch {
      toast.error("No se pudo generar el Anexo 02");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <SheetTitle className="text-popover-foreground">
              Anexo 02 — Financiamiento y Cuotas
            </SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Precio total</Label>
                <Input
                  type="number"
                  value={precioTotal}
                  onChange={(e) => setPrecioTotal(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Cuota inicial</Label>
                <Input
                  type="number"
                  value={cuotaInicial}
                  onChange={(e) => setCuotaInicial(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-muted/50 p-3 text-sm">
              <span className="text-muted-foreground">Saldo a financiar: </span>
              <span className="font-semibold text-foreground">
                {formatCurrency(saldo, currency)}
              </span>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">Tipo de financiamiento</Label>
              <select
                value={tipoFinanciamiento}
                onChange={(e) => setTipoFinanciamiento(e.target.value as FinanciamientoTipo)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                <option value="contado">Pago al Contado</option>
                <option value="credito_directo">Crédito Directo (Inmobiliaria)</option>
                <option value="credito_hipotecario">Crédito Hipotecario (Banco + Inmobiliaria)</option>
              </select>
            </div>

            <div className="flex items-end gap-2">
              <div className="grid flex-1 gap-2">
                <Label className="text-muted-foreground">N° de cuotas</Label>
                <Input
                  type="number"
                  value={numCuotas}
                  onChange={(e) => setNumCuotas(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={generarCuotas}
                className="border-border bg-card text-foreground hover:bg-muted"
              >
                Generar cronograma
              </Button>
            </div>

            {cuotas.length > 0 && (
              <div className="space-y-2">
                <Label className="text-muted-foreground">Cronograma (editable)</Label>
                <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border border-border p-2">
                  {cuotas.map((c, i) => (
                    <div key={c.numero} className="flex items-center gap-2 text-sm">
                      <span className="w-6 shrink-0 text-muted-foreground">{c.numero}.</span>
                      <Input
                        type="date"
                        value={c.fecha_limite}
                        onChange={(e) => updateCuota(i, "fecha_limite", e.target.value)}
                        className="border-border bg-muted text-foreground"
                      />
                      <Input
                        type="number"
                        value={c.monto}
                        onChange={(e) => updateCuota(i, "monto", e.target.value)}
                        className="w-28 shrink-0 border-border bg-muted text-foreground"
                      />
                    </div>
                  ))}
                </div>

                <div
                  className={cn(
                    "flex items-center justify-between rounded-lg border p-3 text-sm",
                    cuadra
                      ? "border-green-500/30 bg-green-500/10"
                      : "border-amber-500/30 bg-amber-500/10",
                  )}
                >
                  <div>
                    <p className={cuadra ? "text-green-400" : "text-amber-400"}>
                      Suma de cuotas: {formatCurrency(cuotasSum, currency)}
                    </p>
                    {!cuadra && (
                      <p className="text-xs text-amber-400/80">
                        Diferencia: {formatCurrency(diff, currency)}
                      </p>
                    )}
                  </div>
                  {!cuadra && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={ajustarDiferencia}
                      className="border-amber-500/40 bg-transparent text-amber-400 hover:bg-amber-500/10"
                    >
                      <Scale className="mr-1 h-3.5 w-3.5" />
                      Ajustar diferencia en la última cuota
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-border/50 bg-popover/80 p-4">
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="flex-1 border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || cuotas.length === 0 || !cuadra}
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {saving ? "Generando..." : "Generar Anexo 02"}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
