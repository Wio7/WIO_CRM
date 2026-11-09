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
// Money is written only through the RPCs of migration 084 (see
// `@/lib/payment-plans/rpc`): they validate amount, date, parts and
// permissions, and keep the payment ledger. Balances are re-read from the
// views after every write instead of being patched in memory: the views
// are the only thing allowed to do that arithmetic.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useCan } from "@/hooks/use-can";
import {
  registerAdvance,
  registerPayment,
  voidPayment,
  type RpcResult,
} from "@/lib/payment-plans/rpc";
import { validateAdvance } from "@/lib/advance-payments";
import { formatCurrency } from "@/lib/currency";
import {
  MEDIA_MAX_BYTES_BY_KIND,
  signedDocUrl,
  uploadAccountDoc,
} from "@/lib/storage/upload-media";
import { PrepaymentDialog } from "./prepayment-dialog";
import { hoyLima } from "@/lib/collections";
import { cn } from "@/lib/utils";
import type {
  Installment,
  PaymentPlan,
  PaymentPlanBalance,
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
  ChevronsRight,
  FileText,
  Loader2,
  Paperclip,
  PiggyBank,
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

/** Una fila del libro de pagos (084). */
interface Pago {
  id: string;
  installment_id: string;
  amount: number;
  method: string | null;
  reference: string | null;
  voucher_path: string | null;
  paid_on: string;
  late_fee_at_payment: number | null;
  voided_at: string | null;
  void_reason: string | null;
}

/** Una fila de `installment_balances` (084). */
interface SaldoCuota {
  installment_id: string;
  remaining: number;
  paid_so_far: number;
  parts: number;
}

const METODOS = ["Yape", "Plin", "Transferencia", "Depósito", "Efectivo"];

// Día de Lima, igual que la vista de saldos (083) y Cobranzas.
const hoy = () => hoyLima();

// Dinero en centavos enteros: nunca se suma ni se resta con decimales.
const aCents = (n: number | string | null | undefined) => Math.round(Number(n ?? 0) * 100);
const centsAMonto = (c: number) => (c / 100).toFixed(2);

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
  const [abonoOpen, setAbonoOpen] = useState(false);
  // Libro de pagos y saldos por cuota (084). Vacíos si 084 no está aplicada.
  const [pagos, setPagos] = useState<Pago[]>([]);
  const [saldos, setSaldos] = useState<Record<string, SaldoCuota>>({});
  const [maxPartes, setMaxPartes] = useState<number | null>(null);
  // Anular un pago: el que se está anulando y su motivo.
  const [anulando, setAnulando] = useState<string | null>(null);
  const [motivo, setMotivo] = useState("");
  // Adelantar cuotas: panel abierto y cuotas marcadas.
  const [adelantando, setAdelantando] = useState(false);
  const [marcadas, setMarcadas] = useState<string[]>([]);
  const cargar = useCallback(async () => {
    if (!planId) return;
    const [{ data: p }, { data: cs }, { data: b }, { data: pg }, { data: sd }] = await Promise.all([
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
      // Antes de 084 estas dos no existen: el error se ignora y quedan vacías.
      supabase
        .from("installment_payments")
        .select("id, installment_id, amount, method, reference, voucher_path, paid_on, late_fee_at_payment, voided_at, void_reason")
        .eq("plan_id", planId)
        .order("paid_on")
        .order("created_at"),
      supabase
        .from("installment_balances")
        .select("installment_id, remaining, paid_so_far, parts")
        .eq("plan_id", planId),
    ]);
    setPlan((p as PaymentPlan) ?? null);
    setCuotas((cs as Installment[]) ?? []);
    setBalance((b as PaymentPlanBalance) ?? null);
    setPagos((pg as Pago[]) ?? []);
    setSaldos(
      Object.fromEntries(((sd as SaldoCuota[]) ?? []).map((x) => [x.installment_id, x])),
    );
    // Máximo de partes del plan (o, si no lo tiene, el de la cuenta).
    const terms = (p as { collection_terms?: { max_payment_parts?: number } | null } | null)
      ?.collection_terms;
    if (terms?.max_payment_parts) {
      setMaxPartes(Number(terms.max_payment_parts));
    } else if (p) {
      const { data: acc } = await supabase
        .from("accounts")
        .select("max_payment_parts")
        .eq("id", (p as PaymentPlan).account_id)
        .maybeSingle();
      setMaxPartes(acc?.max_payment_parts ? Number(acc.max_payment_parts) : null);
    }
  }, [planId, supabase]);

  useEffect(() => {
    if (!planId) {
      setPlan(null);
      setCuotas([]);
      setBalance(null);
      setPagos([]);
      setSaldos({});
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

  // Cuotas que se pueden marcar para adelantar: pendientes, no vencidas.
  const adelantables = useMemo(
    () => cuotas.filter((x) => x.status === "pendiente" && x.due_date >= hoy()),
    [cuotas],
  );

  function abrirCobro(c: Installment) {
    setCobrando(c.id);
    setAdelantando(false);
    setAnulando(null);
    // Por defecto, lo que falta de la cuota (no el monto completo).
    setMonto(centsAMonto(faltaCents(c)));
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

  /** Lo que falta de una cuota, en centavos (lo dice la vista; sin ella, el monto). */
  function faltaCents(c: Installment): number {
    const sd = saldos[c.id];
    return sd ? aCents(sd.remaining) : aCents(c.amount);
  }

  /** Muestra el resultado de un RPC y, si salió bien, recarga todo. */
  async function terminar(res: RpcResult, exito: string): Promise<boolean> {
    setGuardando(false);
    if (!res.ok) {
      // El mensaje de la base es la explicación (regla de 7 días, partes, monto).
      toast.error(res.message);
      // Que la pantalla no quede vieja si otro asesor cambió algo mientras tanto.
      await cargar();
      return false;
    }
    toast.success(exito);
    await cargar();
    onChanged();
    return true;
  }

  async function registrarPago(c: Installment) {
    if (!plan) return;
    const cents = aCents(monto);
    if (cents <= 0) {
      toast.error("Escribe cuánto pagó");
      return;
    }
    setGuardando(true);
    const res = await registerPayment(supabase, {
      installmentId: c.id,
      amount: cents / 100,
      method: metodo.trim() || null,
      reference: operacion.trim() || null,
      voucherPath: voucher,
      paidOn: pagadoEl,
    });
    if (await terminar(res, `Pago registrado en la cuota ${c.number}`)) setCobrando(null);
  }

  async function anularPago(pg: Pago) {
    if (motivo.trim().length < 3) {
      toast.error("Escribe el motivo de la anulación");
      return;
    }
    setGuardando(true);
    const res = await voidPayment(supabase, { paymentId: pg.id, reason: motivo.trim() });
    if (await terminar(res, "Pago anulado")) {
      setAnulando(null);
      setMotivo("");
    }
  }

  function abrirAdelanto() {
    setAdelantando(true);
    setCobrando(null);
    setAnulando(null);
    setMarcadas([]);
    setPagadoEl(hoy());
    setMetodo("");
    setOperacion("");
    setVoucher(null);
  }

  async function adelantarCuotas() {
    if (!plan) return;
    const pendientes = cuotas
      .filter((x) => x.status === "pendiente")
      .map((x) => ({ id: x.id, number: x.number, due_date: x.due_date }));
    const check = validateAdvance(pendientes, marcadas, hoy());
    if (!check.ok) {
      toast.error(check.error);
      return;
    }
    setGuardando(true);
    const res = await registerAdvance(supabase, {
      planId: plan.id,
      installmentIds: marcadas,
      method: metodo.trim() || null,
      reference: operacion.trim() || null,
      voucherPath: voucher,
      paidOn: pagadoEl,
    });
    if (await terminar(res, `${marcadas.length} cuotas adelantadas`)) setAdelantando(false);
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
                valor={`${(balance?.paid_count ?? 0) + cuotas.filter((x) => x.status === "adelantada").length} de ${plan.installments_count}`}
              />
            </div>

            <p className="text-xs text-muted-foreground">
              Moneda: <span className="text-foreground">{plan.currency}</span>
            </p>

            {plan.status === "activo" && (balance?.pending_count ?? 0) > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {(balance?.prepaid_amount ?? 0) > 0
                    ? `Abonos a capital: ${formatCurrency(balance?.prepaid_amount ?? 0, plan.currency)}`
                    : "¿El cliente adelanta plata? Registra un abono a capital."}
                </p>
                <GatedButton
                  canAct={canAct}
                  gateReason="registrar abonos"
                  onClick={() => setAbonoOpen(true)}
                  disabled={guardando}
                  className="h-8 bg-muted px-2.5 text-xs text-foreground hover:bg-muted/70"
                >
                  <PiggyBank className="mr-1.5 h-3.5 w-3.5" />
                  Abono a capital
                </GatedButton>
              </div>
            )}

            {plan.status === "activo" && adelantables.length > 0 && !adelantando && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  ¿El cliente paga cuotas por adelantado? Elige cuáles.
                </p>
                <GatedButton
                  canAct={canAct}
                  gateReason="adelantar cuotas"
                  onClick={abrirAdelanto}
                  disabled={guardando}
                  className="h-8 bg-muted px-2.5 text-xs text-foreground hover:bg-muted/70"
                >
                  <ChevronsRight className="mr-1.5 h-3.5 w-3.5" />
                  Adelantar cuotas
                </GatedButton>
              </div>
            )}

            {adelantando && (
              <div className="space-y-3 rounded-lg border border-border p-3">
                <p className="text-sm font-medium text-foreground">Adelantar cuotas</p>
                <p className="text-xs text-muted-foreground">
                  Marca las siguientes cuotas en orden, o las últimas. Cada una se paga por lo
                  que le falta.
                </p>
                <ul className="max-h-48 space-y-1 overflow-y-auto">
                  {adelantables.map((x) => (
                    <li key={x.id}>
                      <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                        <input
                          type="checkbox"
                          checked={marcadas.includes(x.id)}
                          onChange={(e) =>
                            setMarcadas((m) =>
                              e.target.checked ? [...m, x.id] : m.filter((id) => id !== x.id),
                            )
                          }
                        />
                        Cuota {x.number}
                        <span className="tabular-nums text-muted-foreground">
                          {formatCurrency(faltaCents(x) / 100, plan.currency)} · vence{" "}
                          {fecha(x.due_date)}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="adel-fecha" className="text-xs">
                      Fecha
                    </Label>
                    <Input
                      id="adel-fecha"
                      type="date"
                      value={pagadoEl}
                      onChange={(e) => setPagadoEl(e.target.value)}
                      className="h-9 border-border bg-muted text-foreground"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="adel-metodo" className="text-xs">
                      Cómo pagó
                    </Label>
                    <Input
                      id="adel-metodo"
                      value={metodo}
                      onChange={(e) => setMetodo(e.target.value)}
                      placeholder="Yape, transferencia…"
                      className="h-9 border-border bg-muted text-foreground"
                    />
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="adel-op" className="text-xs">
                    N° de operación
                  </Label>
                  <Input
                    id="adel-op"
                    value={operacion}
                    onChange={(e) => setOperacion(e.target.value)}
                    className="h-9 border-border bg-muted text-foreground"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => setAdelantando(false)}
                    className="h-9 text-muted-foreground hover:text-foreground"
                  >
                    Cancelar
                  </Button>
                  <Button
                    onClick={adelantarCuotas}
                    disabled={guardando || marcadas.length === 0}
                    className="h-9 bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    {guardando ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Guardando…
                      </>
                    ) : (
                      `Adelantar ${marcadas.length || ""} cuotas`
                    )}
                  </Button>
                </div>
              </div>
            )}

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
                const sd = saldos[c.id];
                const partes = sd?.parts ?? 0;
                const pagosCuota = pagos.filter((x) => x.installment_id === c.id);
                const centsMonto = aCents(monto);
                const centsFalta = faltaCents(c);
                // La parte que se va a registrar es la número partes + 1.
                const parteNueva = partes + 1;
                const avisoPartes =
                  maxPartes !== null && centsMonto > 0 && centsMonto < centsFalta
                    ? parteNueva > maxPartes
                      ? `Ya se pasó del máximo de ${maxPartes} partes: solo gerencia puede seguir partiendo esta cuota.`
                      : parteNueva === maxPartes
                        ? `Esta es la última parte permitida (${maxPartes}): tiene que completar la cuota (${formatCurrency(centsFalta / 100, plan.currency)}).`
                        : null
                    : null;
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
                              : c.status === "adelantada"
                                ? "Cubierta por abono a capital"
                              : `Vence el ${fecha(c.due_date)}${vencida ? " · atrasada" : ""}${
                                  enRevision ? " · voucher en revisión" : ""
                                }`}
                        </p>
                        {c.status === "pendiente" && partes > 0 && (
                          <p className="text-xs text-muted-foreground">
                            Pagado {formatCurrency(aCents(sd?.paid_so_far) / 100, plan.currency)}, falta{" "}
                            {formatCurrency(centsFalta / 100, plan.currency)} ·{" "}
                            {partes} {partes === 1 ? "parte pagada" : "partes pagadas"}
                            {maxPartes !== null ? ` (máximo ${maxPartes})` : ""}
                          </p>
                        )}
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
                        {c.status === "pendiente" && !abierto ? (
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

                    {pagosCuota.length > 0 && (
                      <ul className="mt-2 space-y-1 border-t border-border pt-2">
                        {pagosCuota.map((pg) => (
                          <li key={pg.id} className="text-xs">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span
                                className={cn(
                                  "tabular-nums",
                                  pg.voided_at
                                    ? "text-muted-foreground line-through"
                                    : "text-foreground",
                                )}
                              >
                                {formatCurrency(aCents(pg.amount) / 100, plan.currency)} ·{" "}
                                {fecha(pg.paid_on)}
                                {pg.method ? ` · ${pg.method}` : ""}
                                {pg.reference ? ` · Op. ${pg.reference}` : ""}
                                {!pg.voided_at && pg.late_fee_at_payment != null
                                  ? ` · Mora estimada ${formatCurrency(aCents(pg.late_fee_at_payment) / 100, plan.currency)}`
                                  : ""}
                              </span>
                              {pg.voided_at ? (
                                <span className="text-muted-foreground">
                                  Anulado: {pg.void_reason}
                                </span>
                              ) : anulando !== pg.id ? (
                                <GatedButton
                                  canAct={canAct}
                                  gateReason="anular pagos"
                                  onClick={() => {
                                    setAnulando(pg.id);
                                    setMotivo("");
                                  }}
                                  disabled={guardando}
                                  className="h-7 bg-muted px-2 text-xs text-muted-foreground hover:text-foreground"
                                >
                                  <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                                  Anular pago
                                </GatedButton>
                              ) : null}
                            </div>
                            {anulando === pg.id && (
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <Input
                                  value={motivo}
                                  onChange={(e) => setMotivo(e.target.value)}
                                  placeholder="Motivo de la anulación"
                                  className="h-8 flex-1 border-border bg-muted text-foreground"
                                />
                                <Button
                                  variant="ghost"
                                  onClick={() => setAnulando(null)}
                                  className="h-8 text-xs text-muted-foreground hover:text-foreground"
                                >
                                  Cancelar
                                </Button>
                                <Button
                                  onClick={() => anularPago(pg)}
                                  disabled={guardando}
                                  className="h-8 bg-red-600 text-xs text-white hover:bg-red-600/90"
                                >
                                  {guardando ? "Anulando…" : "Anular"}
                                </Button>
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}

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
                              step="0.01"
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

                        {avisoPartes && (
                          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
                            {avisoPartes}
                          </p>
                        )}

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
        {plan && abonoOpen && (
          <PrepaymentDialog
            open
            onOpenChange={setAbonoOpen}
            planId={plan.id}
            currency={plan.currency}
            cuotas={cuotas}
            onDone={async () => {
              await cargar();
              onChanged();
            }}
          />
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
