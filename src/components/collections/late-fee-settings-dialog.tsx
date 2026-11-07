"use client";

// Configurar la mora de la cuenta (migración 083). Solo admins: la policy
// accounts_update lo hace cumplir en la base.

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import type { LateFeeSettings, LateFeeType } from "@/lib/late-fees";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  current: LateFeeSettings;
  onSaved: (s: LateFeeSettings) => void;
}

const TIPOS: ReadonlyArray<{ key: LateFeeType; label: string; sub: string }> = [
  { key: "ninguna", label: "Sin mora", sub: "No se calcula recargo" },
  { key: "fija", label: "Monto fijo", sub: "Por cada cuota vencida" },
  { key: "porcentaje_mensual", label: "% mensual", sub: "Sobre la cuota, según los días" },
];

export function LateFeeSettingsDialog({ open, onOpenChange, accountId, current, onSaved }: Props) {
  const [tipo, setTipo] = useState<LateFeeType>(current.type);
  const [valor, setValor] = useState(current.type === "ninguna" ? "" : String(current.value));
  const [gracia, setGracia] = useState(String(current.graceDays));
  const [guardando, setGuardando] = useState(false);

  async function guardar() {
    const v = tipo === "ninguna" ? 0 : Number(valor);
    const g = Number(gracia || 0);
    if (tipo !== "ninguna" && !(v > 0)) return toast.error("Pon un valor mayor a cero.");
    if (tipo === "porcentaje_mensual" && v > 100) return toast.error("El porcentaje no puede pasar de 100.");
    if (!Number.isInteger(g) || g < 0 || g > 365) return toast.error("Los días de gracia van de 0 a 365.");
    setGuardando(true);
    const { data, error } = await createClient()
      .from("accounts")
      .update({ late_fee_type: tipo, late_fee_value: v, late_fee_grace_days: g })
      .eq("id", accountId)
      .select("id");
    setGuardando(false);
    if (error) {
      toast.error(
        /late_fee/i.test(error.message)
          ? "Falta aplicar la migración 083 (mora y abonos) en Supabase."
          : `No se pudo guardar: ${error.message}`,
      );
      return;
    }
    // Sin fila devuelta = la base no dejó cambiarla (solo admins).
    if (!data || data.length === 0) {
      toast.error("No se guardó: solo un administrador de la cuenta puede cambiar la mora.");
      return;
    }
    toast.success("Mora guardada");
    onSaved({ type: tipo, value: v, graceDays: g });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mora por atraso</DialogTitle>
          <DialogDescription>
            Se calcula y se muestra en Cobranzas. No se suma sola a la deuda: la oficina decide si la cobra.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-2">
          {TIPOS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTipo(t.key)}
              className={
                "rounded-lg border p-2 text-left text-sm " +
                (tipo === t.key ? "border-primary bg-primary/10" : "border-border hover:bg-muted")
              }
            >
              <span className="font-medium">{t.label}</span>
              <span className="block text-[11px] text-muted-foreground">{t.sub}</span>
            </button>
          ))}
        </div>

        {tipo !== "ninguna" && (
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-xs text-muted-foreground">
              {tipo === "fija" ? "Monto por cuota" : "% al mes"}
              <Input type="number" inputMode="decimal" min="0" step="0.01" value={valor} onChange={(e) => setValor(e.target.value)} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Días de gracia
              <Input type="number" inputMode="numeric" min="0" max="365" value={gracia} onChange={(e) => setGracia(e.target.value)} />
            </label>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={guardando}>
            Cancelar
          </Button>
          <Button onClick={guardar} disabled={guardando}>
            {guardando && <Loader2 className="h-4 w-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
