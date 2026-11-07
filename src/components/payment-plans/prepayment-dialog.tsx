"use client";

// Abono a capital (migración 083): el cliente adelanta plata y bajan las
// cuotas futuras (reducir cuota) o se cubren las últimas (reducir plazo).
// El cálculo está en src/lib/prepayments.ts (con pruebas); la base lo
// vuelve a validar y lo aplica en una transacción (RPC apply_prepayment).

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/currency";
import { hoyLima } from "@/lib/collections";
import { planPrepayment, type PrepaymentMode } from "@/lib/prepayments";
import type { Installment } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const METODOS = ["Yape", "Plin", "Transferencia", "Depósito", "Efectivo"];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planId: string;
  currency: string;
  cuotas: Installment[];
  onDone: () => void;
}

export function PrepaymentDialog({ open, onOpenChange, planId, currency, cuotas, onDone }: Props) {
  const today = useMemo(() => hoyLima(), []);
  const [monto, setMonto] = useState("");
  const [modo, setModo] = useState<PrepaymentMode>("reducir_plazo");
  const [metodo, setMetodo] = useState("");
  const [operacion, setOperacion] = useState("");
  const [nota, setNota] = useState("");
  const [guardando, setGuardando] = useState(false);

  const pendientes = useMemo(() => cuotas.filter((c) => c.status === "pendiente"), [cuotas]);
  const calculo = useMemo(
    () => planPrepayment(pendientes, Number(monto), modo, today),
    [pendientes, monto, modo, today],
  );
  const resumen = useMemo(() => {
    if (!calculo.changes) return null;
    const cubiertas = calculo.changes.filter((c) => c.status === "adelantada").length;
    const rebajadas = calculo.changes.length - cubiertas;
    const ejemplo = calculo.changes.find((c) => c.status === "pendiente")?.newAmount;
    return { cubiertas, rebajadas, ejemplo };
  }, [calculo]);

  async function aplicar() {
    if (!calculo.changes) {
      toast.error(calculo.error ?? "Revisa el monto");
      return;
    }
    setGuardando(true);
    const { error } = await createClient().rpc("apply_prepayment", {
      p_plan_id: planId,
      p_amount: Number(monto),
      p_mode: modo,
      p_changes: calculo.changes.map((c) => ({ id: c.id, newAmount: c.newAmount })),
      p_method: metodo || null,
      p_reference: operacion || null,
      p_note: nota || null,
    });
    setGuardando(false);
    if (error) {
      const falta = /apply_prepayment|could not find the function/i.test(error.message);
      toast.error(falta ? "Falta aplicar la migración 083 (mora y abonos) en Supabase." : `No se pudo aplicar: ${error.message}`);
      return;
    }
    toast.success(`Abono de ${formatCurrency(Number(monto), currency)} aplicado`);
    onDone();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Abono a capital</DialogTitle>
          <DialogDescription>
            Se aplica a las cuotas que vencen de hoy en adelante. Puede abonar hasta{" "}
            {formatCurrency(calculo.available, currency)}.
          </DialogDescription>
        </DialogHeader>

        {calculo.overdueSkipped > 0 && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
            Tiene {calculo.overdueSkipped} cuota{calculo.overdueSkipped === 1 ? "" : "s"} vencida
            {calculo.overdueSkipped === 1 ? "" : "s"}: el abono no las toca; esas se registran como pago.
          </p>
        )}

        <div className="space-y-3">
          <label className="block space-y-1 text-xs text-muted-foreground">
            Monto del abono
            <Input type="number" inputMode="decimal" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} />
          </label>

          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["reducir_plazo", "Reducir plazo", "Cubre las últimas cuotas"],
                ["reducir_cuota", "Reducir cuota", "Baja todas las cuotas futuras"],
              ] as const
            ).map(([k, titulo, sub]) => (
              <button
                key={k}
                type="button"
                onClick={() => setModo(k)}
                className={
                  "rounded-lg border p-2.5 text-left text-sm " +
                  (modo === k ? "border-primary bg-primary/10" : "border-border hover:bg-muted")
                }
              >
                <span className="font-medium">{titulo}</span>
                <span className="block text-xs text-muted-foreground">{sub}</span>
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              Método
              <Input list="metodos-abono" value={metodo} onChange={(e) => setMetodo(e.target.value)} placeholder="Yape, BCP…" />
              <datalist id="metodos-abono">
                {METODOS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              N° de operación
              <Input value={operacion} onChange={(e) => setOperacion(e.target.value)} />
            </label>
          </div>
          <label className="block space-y-1 text-xs text-muted-foreground">
            Nota
            <Textarea rows={2} maxLength={1000} value={nota} onChange={(e) => setNota(e.target.value)} />
          </label>

          {monto && (
            <p className={"rounded-lg p-2 text-xs " + (calculo.error ? "bg-rose-500/10 text-rose-300" : "bg-muted/40")}>
              {calculo.error
                ? calculo.error
                : modo === "reducir_plazo"
                  ? `Quedan cubiertas ${resumen?.cubiertas ?? 0} cuota(s) del final${
                      resumen?.rebajadas ? " y una baja a " + formatCurrency(resumen.ejemplo ?? 0, currency) : ""
                    }.`
                  : `Las ${calculo.changes?.length ?? 0} cuotas futuras bajan a unos ${formatCurrency(
                      resumen?.ejemplo ?? 0,
                      currency,
                    )} cada una.`}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={guardando}>
            Cancelar
          </Button>
          <Button onClick={aplicar} disabled={guardando || !calculo.changes}>
            {guardando && <Loader2 className="h-4 w-4 animate-spin" />}
            Aplicar abono
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
