"use client";

// ============================================================
// /collections/vouchers — cola de vouchers por revisar.
//
// Cuotas pendientes con un voucher que mandó el cliente. Aprobar registra
// el pago por el RPC de la 084 (la base toma el voucher de la cuota y lo
// limpia); rechazar limpia el voucher y deja el motivo. Nunca se escribe
// dinero directo en las tablas: si la 084 falta, se avisa.
// ============================================================

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Check, FileText, Loader2, X } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/currency";
import { fechaLima } from "@/lib/collections";
import { registerPayment, rejectVoucher, type RpcResult } from "@/lib/payment-plans/rpc";
import { signedDocUrl } from "@/lib/storage/upload-media";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface VoucherRow {
  id: string;
  number: number;
  amount: number | string;
  due_date: string;
  voucher_path: string;
  declared_amount: number | string | null;
  paid_method: string | null;
  paid_reference: string | null;
  plan: {
    currency: string;
    contact: { name: string | null; phone: string | null } | null;
    unit: { code: string } | null;
  } | null;
}

const SELECT =
  "id, number, amount, due_date, voucher_path, declared_amount, paid_method, paid_reference, plan:payment_plans(currency, contact:contacts(name, phone), unit:real_estate_units(code))";

export default function VouchersPage() {
  const { moduleAccess } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<VoucherRow[]>([]);
  const [saldos, setSaldos] = useState<Record<string, number>>({});
  const [falta084, setFalta084] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rechazando, setRechazando] = useState<string | null>(null);
  const [motivo, setMotivo] = useState("");

  const cargar = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("installments")
      .select(SELECT)
      .eq("status", "pendiente")
      .not("voucher_path", "is", null)
      .order("due_date", { ascending: true })
      .order("id", { ascending: true })
      .limit(500);
    if (err) {
      setError(err.message);
      setLoading(false);
      return;
    }
    const list = (data ?? []) as unknown as VoucherRow[];
    const sd: Record<string, number> = {};
    if (list.length) {
      const { data: bal, error: errBal } = await supabase
        .from("installment_balances")
        .select("installment_id, remaining")
        .in("installment_id", list.map((r) => r.id));
      // Sin la vista (084 sin aplicar) no hay saldos ni forma de registrar pagos.
      if (errBal) setFalta084(true);
      for (const b of (bal ?? []) as { installment_id: string; remaining: number | string }[]) {
        sd[b.installment_id] = Number(b.remaining);
      }
    }
    setError(null);
    setSaldos(sd);
    setRows(list);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga inicial de la cola
    void cargar();
  }, [cargar]);

  /** Lo que se aprueba: lo que declaró el cliente (puede ser una parte) o lo que falta. */
  function montoAprobar(r: VoucherRow): number {
    const declarado = Number(r.declared_amount);
    if (declarado > 0) return declarado;
    return saldos[r.id] ?? Number(r.amount);
  }

  async function terminar(res: RpcResult, ok: string) {
    setBusy(null);
    if (!res.ok) {
      if (res.missing084) setFalta084(true);
      toast.error(res.message);
      return false;
    }
    toast.success(ok);
    await cargar();
    return true;
  }

  async function aprobar(r: VoucherRow) {
    setBusy(r.id);
    // voucherPath null: el RPC toma el voucher de la cuota (y su método/operación).
    const res = await registerPayment(supabase, {
      installmentId: r.id,
      amount: montoAprobar(r),
      method: r.paid_method,
      reference: r.paid_reference,
      voucherPath: null,
    });
    await terminar(res, `Cuota ${r.number} aprobada`);
  }

  async function rechazar(r: VoucherRow) {
    if (motivo.trim().length < 3) {
      toast.error("Escribe el motivo del rechazo");
      return;
    }
    setBusy(r.id);
    const res = await rejectVoucher(supabase, { installmentId: r.id, reason: motivo.trim() });
    if (await terminar(res, "Voucher rechazado")) {
      setRechazando(null);
      setMotivo("");
    }
  }

  async function ver(path: string) {
    const url = await signedDocUrl("client-docs", path);
    if (!url) {
      toast.error("No se pudo abrir el voucher");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  if (moduleAccess?.cobranzas === false) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        Sin acceso a Cobranzas. Pídele al dueño de la cuenta que te asigne el área.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/collections" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Cobranzas
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <FileText className="h-6 w-6 text-primary" /> Vouchers por revisar
        </h1>
        <p className="text-sm text-muted-foreground">
          Cuotas con un voucher que mandó el cliente. Al aprobar se registra el pago con ese voucher.
        </p>
      </div>

      {falta084 && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          Falta aplicar la migración 084 (pagos protegidos) en Supabase: sin ella no se pueden aprobar ni rechazar vouchers.
        </p>
      )}
      {error && <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm">No se pudo cargar: {error}</p>}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? null : rows.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">No hay vouchers por revisar.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const cur = r.plan?.currency ?? "PEN";
            const aprobarMonto = montoAprobar(r);
            const esParte = Number(r.declared_amount) > 0 && aprobarMonto < (saldos[r.id] ?? Number(r.amount));
            return (
              <li key={r.id} className="rounded-xl border border-border bg-card p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{r.plan?.contact?.name ?? "Cliente sin nombre"}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.plan?.unit?.code ? `Lote ${r.plan.unit.code} · ` : ""}Cuota {r.number} · vence {fechaLima(r.due_date)}
                    </p>
                    <p className="mt-1 text-sm">
                      Se aprobará <span className="font-semibold">{formatCurrency(aprobarMonto, cur)}</span>
                      {esParte && <span className="text-xs text-muted-foreground"> (parte declarada por el cliente)</span>}
                    </p>
                    {(r.paid_method || r.paid_reference) && (
                      <p className="text-xs text-muted-foreground">
                        {[r.paid_method, r.paid_reference && `Operación ${r.paid_reference}`].filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => ver(r.voucher_path)}>
                      <FileText className="h-3.5 w-3.5" /> Ver voucher
                    </Button>
                    <Button size="sm" onClick={() => aprobar(r)} disabled={busy !== null || falta084}>
                      {busy === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      Aprobar
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setRechazando(rechazando === r.id ? null : r.id);
                        setMotivo("");
                      }}
                      disabled={busy !== null || falta084}
                    >
                      <X className="h-3.5 w-3.5" /> Rechazar
                    </Button>
                  </div>
                </div>
                {rechazando === r.id && (
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <Input
                      placeholder="Motivo del rechazo (el cliente podrá subir otro voucher)"
                      value={motivo}
                      maxLength={500}
                      onChange={(e) => setMotivo(e.target.value)}
                    />
                    <Button size="sm" onClick={() => rechazar(r)} disabled={busy !== null}>
                      Confirmar rechazo
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
