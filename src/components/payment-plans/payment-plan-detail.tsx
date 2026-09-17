"use client";

// ============================================================
// One plan, open: the schedule and the act of collecting on it.
//
// This is the screen an advisor has open with the client on the phone,
// so it answers in this order: what is overdue, what is next, and what
// has already been paid. Registering a payment is one tap on the cuota
// and a small form beside it, never a separate page, because the advisor
// is mid-call and loses the thread.
//
// Everything written here goes to `installments` (043) plus the payment
// detail columns of 047. Balances are re-read from
// `payment_plan_balances` after every write instead of being patched in
// memory: the view is the only thing allowed to do that arithmetic.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { formatCurrency } from "@/lib/currency";
import {
  MEDIA_MAX_BYTES_BY_KIND,
  signedDocUrl,
  uploadAccountDoc,
} from "@/lib/storage/upload-media";
import { falta047 } from "@/lib/payment-plans/migration-047";
import { cn } from "@/lib/utils";
import type {
  Installment,
  PaymentPlan,
  PaymentPlanBalance,
  PaymentPlanStatus,
} from "@/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GatedButton } from "@/components/ui/gated-button";
import {
  Check,
  FileText,
  Loader2,
  Paperclip,
  RotateCcw,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";

interface PaymentPlanDetailProps {
  planId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Called after any write, so the list behind reloads its balances. */
  onChanged: () => void;
}

const METODOS = ["Yape", "Plin", "Transferencia", "Depósito", "Efectivo"];

const hoy = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
};

const fecha = (iso: string | null | undefined) =>
  iso
    ? new Date(iso.length > 10 ? iso : `${iso}T00:00:00`).toLocaleDateString("es-PE", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";

/** Vencida = pendiente y su fecha ya pasó. Igual que la vista de 043. */
const estaVencida = (c: Installment) =>
  c.status === "pendiente" && c.due_date < hoy();

export function PaymentPlanDetail({
  planId,
  onOpenChange,
  onChanged,
}: PaymentPlanDetailProps) {
  const supabase = createClient();
  const { profile } = useAuth();
  const canAct = useCan("send-messages");

  const [plan, setPlan] = useState<PaymentPlan | null>(null);
  const [cuotas, setCuotas] = useState<Installment[]>([]);
  const [balance, setBalance] = useState<PaymentPlanBalance | null>(null);
  const [loading, setLoading] = useState(false);
  const [soloPendientes, setSoloPendientes] = useState(true);
  const [cobrando, setCobrando] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  // El formulario de cobro, uno a la vez: el de la cuota en `cobrando`.
  const [monto, setMonto] = useState("");
  const [pagadoEl, setPagadoEl] = useState(hoy);
  const [metodo, setMetodo] = useState("");
  const [operacion, setOperacion] = useState("");
  const [voucher, setVoucher] = useState<string | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  // Se enciende la primera vez que la base rechaza las columnas de 047.
  const sinDetalle = useRef(false);

  /**
   * Guarda una cuota con el detalle del pago y, si 047 todavía no está
   * aplicada, la guarda sin él: cobrar no puede depender de una migración
   * pendiente.
   */
  const guardarCuota = useCallback(
    async (
      id: string,
      base: Record<string, unknown>,
      detalle: Record<string, unknown>,
    ) => {
      if (!sinDetalle.current) {
        const { error } = await supabase
          .from("installments")
          .update({ ...base, ...detalle })
          .eq("id", id);
        if (!error) return null;
        if (!falta047(error)) return error;
        sinDetalle.current = true;
      }
      const { error } = await supabase.from("installments").update(base).eq("id", id);
      return error;
    },
    [supabase],
  );

  const cargar = useCallback(async () => {
    if (!planId) return;
    const [{ data: p }, { data: cs }, { data: b }] = await Promise.all([
      supabase
        .from("payment_plans")
        .select("*, contact:contacts(*), unit:real_estate_units(*)")
        .eq("id", planId)
        .maybeSingle(),
      supabase
        .from("installments")
        .select("*")
        .eq("plan_id", planId)
        .order("number"),
      supabase
        .from("payment_plan_balances")
        .select("*")
        .eq("plan_id", planId)
        .maybeSingle(),
    ]);
    setPlan((p as PaymentPlan) ?? null);
    setCuotas((cs as Installment[]) ?? []);
    setBalance((b as PaymentPlanBalance) ?? null);
  }, [planId, supabase]);

  useEffect(() => {
    if (!planId) {
      setPlan(null);
      setCuotas([]);
      setBalance(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      await cargar();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [planId, cargar]);

  const visibles = useMemo(
    () => (soloPendientes ? cuotas.filter((c) => c.status === "pendiente") : cuotas),
    [cuotas, soloPendientes],
  );

  const faltantes = plan ? plan.installments_count - cuotas.length : 0;

  function abrirCobro(c: Installment) {
    setCobrando(c.id);
    setMonto(String(c.amount));
    setPagadoEl(hoy());
    setMetodo("");
    setOperacion("");
    setVoucher(null);
  }

  async function subirVoucher(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MEDIA_MAX_BYTES_BY_KIND.document) {
      toast.error("La imagen es muy pesada");
      return;
    }
    setSubiendo(true);
    try {
      // Bucket privado (042): guardamos la ruta, nunca una URL pública.
      const { path } = await uploadAccountDoc("client-docs", file);
      setVoucher(path);
      toast.success("Voucher adjuntado");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "No se pudo subir el voucher");
    } finally {
      setSubiendo(false);
    }
  }

  async function verVoucher(path: string) {
    const url = await signedDocUrl("client-docs", path);
    if (!url) {
      toast.error("No se pudo abrir el voucher");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  /**
   * Cierra el plan cuando ya no queda nada pendiente, y lo reabre si
   * alguien deshace un pago. Lo decide el conteo real de cuotas, no el
   * botón que se acaba de tocar.
   */
  const sincronizarEstado = useCallback(
    async (planActual: PaymentPlan, restantes: number) => {
      const deberia: PaymentPlanStatus =
        restantes === 0
          ? "pagado"
          : planActual.status === "pagado"
            ? "activo"
            : planActual.status;
      if (deberia === planActual.status) return;
      await supabase.from("payment_plans").update({ status: deberia }).eq("id", planActual.id);
    },
    [supabase],
  );

  async function registrarPago(c: Installment) {
    if (!plan) return;
    const importe = Number(monto);
    if (!importe || importe <= 0) {
      toast.error("Escribe cuánto pagó");
      return;
    }
    setGuardando(true);
    const error = await guardarCuota(c.id, {
      status: "pagada",
      // Mediodía y no medianoche: la fecha que escribió el asesor es la
      // que tiene que leerse después en Lima, no el día anterior.
      paid_at: new Date(`${pagadoEl}T12:00:00`).toISOString(),
      paid_amount: importe,
    }, {
      paid_method: metodo.trim() || null,
      paid_reference: operacion.trim() || null,
      voucher_path: voucher,
      registered_by: profile?.id ?? null,
    });

    if (error) {
      setGuardando(false);
      toast.error("No se pudo registrar el pago");
      console.error("[payment-plan] pay installment:", error.message);
      return;
    }
    if (voucher && !error && sinDetalle.current) {
      // El pago quedó guardado, pero el voucher no tiene dónde vivir.
      toast.warning("El pago se registró. El voucher no se guardó: falta aplicar la migración 047.");
    }

    const restantes = cuotas.filter(
      (x) => x.status === "pendiente" && x.id !== c.id,
    ).length;
    await sincronizarEstado(plan, restantes);

    setGuardando(false);
    setCobrando(null);
    toast.success(`Cuota ${c.number} pagada`);
    await cargar();
    onChanged();
  }

  async function deshacerPago(c: Installment) {
    if (!plan) return;
    setGuardando(true);
    const error = await guardarCuota(c.id, {
      status: "pendiente",
      paid_at: null,
      paid_amount: null,
    }, {
      paid_method: null,
      paid_reference: null,
      registered_by: profile?.id ?? null,
    });
    if (error) {
      setGuardando(false);
      toast.error("No se pudo deshacer");
      return;
    }
    // Vuelve a haber algo pendiente: el plan ya no está pagado.
    await sincronizarEstado(plan, 1);
    setGuardando(false);
    toast.success(`La cuota ${c.number} vuelve a estar pendiente`);
    await cargar();
    onChanged();
  }

  /**
   * Rellena las cuotas que falten. Existe porque el formulario de creación
   * puede guardar el plan y fallar al escribir su cronograma: sin esto ese
   * plan se queda sin cuotas para siempre y hay que borrarlo a mano.
   */
  async function generarFaltantes() {
    if (!plan || faltantes <= 0) return;
    setGuardando(true);
    const day = plan.due_day ?? Number(plan.first_due_date.slice(8, 10));
    const base = new Date(`${plan.first_due_date}T00:00:00`);
    const desde = cuotas.length;
    const filas = Array.from({ length: faltantes }, (_, k) => {
      const n = desde + k;
      const d = new Date(base.getFullYear(), base.getMonth() + n, 1);
      const ultimo = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, ultimo));
      return {
        plan_id: plan.id,
        account_id: plan.account_id,
        number: n + 1,
        amount: plan.monthly_amount,
        due_date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
          d.getDate(),
        ).padStart(2, "0")}`,
      };
    });
    const { error } = await supabase.from("installments").insert(filas);
    setGuardando(false);
    if (error) {
      toast.error("No se pudieron generar las cuotas");
      console.error("[payment-plan] backfill:", error.message);
      return;
    }
    toast.success(`${faltantes} cuotas generadas`);
    await cargar();
    onChanged();
  }

  return (
    <Sheet open={!!planId} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>
            {plan?.contact?.name || plan?.contact?.phone || "Plan de cuotas"}
          </SheetTitle>
        </SheetHeader>

        {loading || !plan ? (
          <p className="py-16 text-center text-sm text-muted-foreground">Cargando…</p>
        ) : (
          <div className="mt-4 space-y-5">
            {/* Lo que pregunta el cliente, en el orden en que lo pregunta. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Resumen
                titulo="Por cobrar"
                valor={formatCurrency(balance?.pending_amount ?? 0, plan.currency)}
              />
              <Resumen
                titulo="Atrasado"
                valor={formatCurrency(balance?.overdue_amount ?? 0, plan.currency)}
                tono={(balance?.overdue_count ?? 0) > 0 ? "rojo" : undefined}
              />
              <Resumen titulo="Próxima" valor={fecha(balance?.next_due_date)} />
              <Resumen
                titulo="Pagadas"
                valor={`${balance?.paid_count ?? 0} de ${plan.installments_count}`}
              />
            </div>

            <p className="text-xs text-muted-foreground">
              {plan.unit?.code ? `${plan.unit.code} · ` : ""}
              {formatCurrency(plan.total_amount, plan.currency)} en total, inicial{" "}
              {formatCurrency(plan.down_payment, plan.currency)}, cuota{" "}
              {formatCurrency(plan.monthly_amount, plan.currency)}
              {plan.due_day ? ` cada día ${plan.due_day}` : ""}.
            </p>

            {faltantes > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                <p className="text-xs text-amber-200">
                  Este plan debería tener {plan.installments_count} cuotas y solo tiene{" "}
                  {cuotas.length}.
                </p>
                <GatedButton
                  canAct={canAct}
                  gateReason="generar cuotas"
                  onClick={generarFaltantes}
                  disabled={guardando}
                  className="h-8 bg-amber-500/20 text-xs text-amber-100 hover:bg-amber-500/30"
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  Generar las que faltan
                </GatedButton>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSoloPendientes(true)}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-sm transition-colors",
                  soloPendientes
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                Pendientes
              </button>
              <button
                type="button"
                onClick={() => setSoloPendientes(false)}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-sm transition-colors",
                  !soloPendientes
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                Todas ({cuotas.length})
              </button>
            </div>

            <ul className="space-y-2 pb-8">
              {visibles.length === 0 && (
                <li className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
                  {cuotas.length === 0
                    ? "Este plan todavía no tiene cuotas."
                    : "No queda ninguna cuota pendiente."}
                </li>
              )}

              {visibles.map((c) => {
                const vencida = estaVencida(c);
                const enRevision = c.status === "pendiente" && !!c.voucher_path;
                const abierto = cobrando === c.id;
                return (
                  <li
                    key={c.id}
                    className={cn(
                      "rounded-lg border p-3",
                      vencida
                        ? "border-red-500/40 bg-red-500/5"
                        : c.status === "pagada"
                          ? "border-border bg-muted/20"
                          : "border-border",
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          Cuota {c.number}
                          <span className="ml-2 font-normal tabular-nums text-muted-foreground">
                            {formatCurrency(c.amount, plan.currency)}
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {c.status === "pagada"
                            ? `Pagada el ${fecha(c.paid_at)}${c.paid_method ? ` · ${c.paid_method}` : ""}${
                                c.paid_reference ? ` · Op. ${c.paid_reference}` : ""
                              }`
                            : c.status === "condonada"
                              ? "Condonada"
                              : `Vence el ${fecha(c.due_date)}${vencida ? " · atrasada" : ""}${
                                  enRevision ? " · voucher en revisión" : ""
                                }`}
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5">
                        {c.voucher_path && (
                          <Button
                            variant="ghost"
                            onClick={() => verVoucher(c.voucher_path!)}
                            className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                          >
                            <FileText className="mr-1.5 h-3.5 w-3.5" />
                            Voucher
                          </Button>
                        )}
                        {c.status === "pagada" ? (
                          <GatedButton
                            canAct={canAct}
                            gateReason="deshacer pagos"
                            onClick={() => deshacerPago(c)}
                            disabled={guardando}
                            className="h-8 bg-muted px-2 text-xs text-muted-foreground hover:text-foreground"
                          >
                            <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                            Deshacer
                          </GatedButton>
                        ) : c.status === "pendiente" && !abierto ? (
                          <GatedButton
                            canAct={canAct}
                            gateReason="registrar pagos"
                            onClick={() => abrirCobro(c)}
                            className="h-8 bg-primary px-2.5 text-xs text-primary-foreground hover:bg-primary/90"
                          >
                            <Check className="mr-1.5 h-3.5 w-3.5" />
                            Registrar pago
                          </GatedButton>
                        ) : null}
                      </div>
                    </div>

                    {abierto && (
                      <div className="mt-3 space-y-3 border-t border-border pt-3">
                        <div className="grid grid-cols-2 gap-3">
                          <div className="grid gap-1.5">
                            <Label htmlFor={`m-${c.id}`} className="text-xs">
                              Monto pagado
                            </Label>
                            <Input
                              id={`m-${c.id}`}
                              type="number"
                              min="0"
                              step="10"
                              value={monto}
                              onChange={(e) => setMonto(e.target.value)}
                              className="h-9 border-border bg-muted text-foreground"
                            />
                          </div>
                          <div className="grid gap-1.5">
                            <Label htmlFor={`f-${c.id}`} className="text-xs">
                              Fecha
                            </Label>
                            <Input
                              id={`f-${c.id}`}
                              type="date"
                              value={pagadoEl}
                              onChange={(e) => setPagadoEl(e.target.value)}
                              className="h-9 border-border bg-muted text-foreground"
                            />
                          </div>
                        </div>

                        <div className="grid gap-1.5">
                          <Label className="text-xs">Cómo pagó</Label>
                          <div className="flex flex-wrap gap-1.5">
                            {METODOS.map((m) => (
                              <button
                                key={m}
                                type="button"
                                onClick={() => setMetodo(m)}
                                className={cn(
                                  "rounded-lg border px-2.5 py-1 text-xs transition-colors",
                                  metodo === m
                                    ? "border-primary bg-primary/10 text-foreground"
                                    : "border-border text-muted-foreground hover:text-foreground",
                                )}
                              >
                                {m}
                              </button>
                            ))}
                          </div>
                          <Input
                            value={metodo}
                            onChange={(e) => setMetodo(e.target.value)}
                            placeholder="u otro banco"
                            className="h-9 border-border bg-muted text-foreground"
                          />
                        </div>

                        <div className="grid gap-1.5">
                          <Label htmlFor={`o-${c.id}`} className="text-xs">
                            N° de operación
                          </Label>
                          <Input
                            id={`o-${c.id}`}
                            value={operacion}
                            onChange={(e) => setOperacion(e.target.value)}
                            className="h-9 border-border bg-muted text-foreground"
                          />
                        </div>

                        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
                          <input
                            type="file"
                            accept="image/*,application/pdf"
                            onChange={subirVoucher}
                            className="hidden"
                          />
                          {subiendo ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Paperclip className="h-4 w-4" />
                          )}
                          {voucher ? "Voucher adjuntado" : "Adjuntar voucher (opcional)"}
                        </label>

                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            onClick={() => setCobrando(null)}
                            className="h-9 text-muted-foreground hover:text-foreground"
                          >
                            Cancelar
                          </Button>
                          <Button
                            onClick={() => registrarPago(c)}
                            disabled={guardando || subiendo}
                            className="h-9 bg-primary text-primary-foreground hover:bg-primary/90"
                          >
                            {guardando ? (
                              <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Guardando…
                              </>
                            ) : (
                              "Guardar pago"
                            )}
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Resumen({
  titulo,
  valor,
  tono,
}: {
  titulo: string;
  valor: string;
  tono?: "rojo";
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-2.5">
      <p
        className={cn(
          "text-sm font-semibold tabular-nums",
          tono === "rojo" ? "text-red-400" : "text-foreground",
        )}
      >
        {valor}
      </p>
      <p className="text-[11px] text-muted-foreground">{titulo}</p>
    </div>
  );
}
