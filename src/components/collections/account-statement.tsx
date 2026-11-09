"use client";

// ============================================================
// Estado de cuenta del cliente (pantalla + imprimible).
//
// Todo sale del libro de pagos (installment_payments, 084) y de las vistas
// de saldos: por contrato, cada cuota con lo pagado y lo que falta, y la
// lista de pagos con su método y fecha (los anulados se marcan y no suman).
// La mora que aparece es solo una ESTIMACIÓN con la configuración actual
// de la cuenta (decisión del dueño 2026-11-09): nunca forma parte del saldo.
// ============================================================

import { useEffect, useMemo, useState } from "react";
import { Loader2, Printer } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/currency";
import { fechaLima, hoyLima, type OverdueInstallment } from "@/lib/collections";
import { NO_LATE_FEE, lateFeesByDebtor, settingsFromAccount, type LateFeeSettings } from "@/lib/late-fees";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";

interface PlanRow {
  id: string;
  currency: string;
  status: string;
  total_amount: number | string;
  down_payment: number | string | null;
  unit: { code: string } | null;
}
interface CuotaRow {
  id: string;
  plan_id: string;
  number: number;
  amount: number | string;
  due_date: string;
  status: string;
}
interface PagoRow {
  id: string;
  plan_id: string;
  installment_id: string;
  amount: number | string;
  method: string | null;
  reference: string | null;
  paid_on: string;
  late_fee_at_payment: number | string | null;
  voided_at: string | null;
  void_reason: string | null;
}
interface SaldoRow {
  installment_id: string;
  paid_so_far: number | string;
  remaining: number | string;
}

const ESTADO_CUOTA: Record<string, string> = {
  pendiente: "Pendiente",
  pagada: "Pagada",
  condonada: "Condonada",
  adelantada: "Adelantada",
};

const esc = (s: string | number | null | undefined) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export function AccountStatement({ contactId, contactName }: { contactId: string; contactName?: string | null }) {
  const { accountId } = useAuth();
  const today = useMemo(() => hoyLima(), []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [falta084, setFalta084] = useState(false);
  const [name, setName] = useState<string | null>(contactName ?? null);
  const [planes, setPlanes] = useState<PlanRow[]>([]);
  const [cuotas, setCuotas] = useState<CuotaRow[]>([]);
  const [pagos, setPagos] = useState<PagoRow[]>([]);
  const [saldos, setSaldos] = useState<Map<string, SaldoRow>>(new Map());
  const [mora, setMora] = useState<LateFeeSettings>(NO_LATE_FEE);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      setLoading(true);
      const [{ data: c }, { data: pl, error: errPl }] = await Promise.all([
        supabase.from("contacts").select("name").eq("id", contactId).maybeSingle(),
        supabase
          .from("payment_plans")
          .select("id, currency, status, total_amount, down_payment, unit:real_estate_units(code)")
          .eq("contact_id", contactId)
          .order("created_at", { ascending: true }),
      ]);
      const plans = (pl ?? []) as unknown as PlanRow[];
      const planIds = plans.map((p) => p.id);
      let cs: CuotaRow[] = [];
      let pg: PagoRow[] = [];
      let sd: SaldoRow[] = [];
      let err: string | null = errPl?.message ?? null;
      let sin084 = false;
      if (planIds.length) {
        const [rc, rp, rs] = await Promise.all([
          supabase.from("installments").select("id, plan_id, number, amount, due_date, status").in("plan_id", planIds).order("number"),
          supabase
            .from("installment_payments")
            .select("id, plan_id, installment_id, amount, method, reference, paid_on, late_fee_at_payment, voided_at, void_reason")
            .in("plan_id", planIds)
            .order("paid_on")
            .order("created_at"),
          supabase.from("installment_balances").select("installment_id, paid_so_far, remaining").in("plan_id", planIds),
        ]);
        if (rc.error) err = rc.error.message;
        cs = (rc.data ?? []) as CuotaRow[];
        // Sin 084 no hay libro ni vista: se dice, no se inventa un estado de cuenta.
        if (rp.error || rs.error) sin084 = true;
        pg = (rp.data ?? []) as PagoRow[];
        sd = (rs.data ?? []) as SaldoRow[];
      }
      let moraCuenta: LateFeeSettings = NO_LATE_FEE;
      if (accountId) {
        const { data: acc } = await supabase
          .from("accounts")
          .select("late_fee_type, late_fee_value, late_fee_grace_days, late_fee_cap_days")
          .eq("id", accountId)
          .maybeSingle();
        moraCuenta = settingsFromAccount(acc);
      }
      if (cancelled) return;
      setName((c as { name: string | null } | null)?.name ?? contactName ?? null);
      setPlanes(plans);
      setCuotas(cs);
      setPagos(pg);
      setSaldos(new Map(sd.map((s) => [s.installment_id, s])));
      setMora(moraCuenta);
      setFalta084(sin084);
      setError(err);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId, contactName, accountId]);

  // Mora estimada por moneda: sobre las cuotas vencidas con saldo.
  const moraPorMoneda = useMemo(() => {
    const out = new Map<string, number>();
    if (mora.type === "ninguna" || falta084) return out;
    const planById = new Map(planes.map((p) => [p.id, p]));
    const rows: OverdueInstallment[] = [];
    for (const q of cuotas) {
      const p = planById.get(q.plan_id);
      const rem = Number(saldos.get(q.id)?.remaining ?? 0);
      if (!p || q.status !== "pendiente" || q.due_date >= today || rem <= 0) continue;
      rows.push({
        id: q.id,
        plan_id: q.plan_id,
        number: q.number,
        amount: q.amount,
        remaining: rem,
        due_date: q.due_date,
        plan: { id: p.id, currency: p.currency, status: p.status, contact: { id: contactId, name, phone: null }, unit: null },
      });
    }
    for (const [key, v] of lateFeesByDebtor(rows, today, mora)) {
      const cur = key.split("|")[1];
      out.set(cur, (out.get(cur) ?? 0) + v);
    }
    return out;
  }, [mora, falta084, planes, cuotas, saldos, today, contactId, name]);

  function imprimir() {
    const w = window.open("", "_blank");
    if (!w) return;
    const bloques = planes
      .map((p) => {
        const cs = cuotas.filter((q) => q.plan_id === p.id);
        const ps = pagos.filter((x) => x.plan_id === p.id);
        const fmt = (n: number | string) => formatCurrency(Number(n), p.currency);
        return `<h2>${esc(p.unit?.code ? `Lote ${p.unit.code}` : "Contrato")} · ${esc(p.currency)}</h2>
<p>Total ${esc(fmt(p.total_amount))}${p.down_payment ? ` · Inicial ${esc(fmt(p.down_payment))}` : ""}</p>
<table><tr><th>Cuota</th><th>Vence</th><th>Monto</th><th>Pagado</th><th>Falta</th><th>Estado</th></tr>
${cs.map((q) => `<tr><td>${q.number}</td><td>${esc(fechaLima(q.due_date))}</td><td>${esc(fmt(q.amount))}</td><td>${esc(fmt(saldos.get(q.id)?.paid_so_far ?? 0))}</td><td>${esc(fmt(saldos.get(q.id)?.remaining ?? 0))}</td><td>${esc(ESTADO_CUOTA[q.status] ?? q.status)}</td></tr>`).join("")}</table>
<h3>Pagos</h3>
<table><tr><th>Fecha</th><th>Cuota</th><th>Monto</th><th>Método</th><th>Operación</th><th>Estado</th></tr>
${ps.map((x) => `<tr><td>${esc(fechaLima(x.paid_on))}</td><td>${esc(cs.find((q) => q.id === x.installment_id)?.number ?? "")}</td><td>${esc(fmt(x.amount))}</td><td>${esc(x.method)}</td><td>${esc(x.reference)}</td><td>${x.voided_at ? `Anulado: ${esc(x.void_reason)}` : "Vigente"}</td></tr>`).join("") || '<tr><td colspan="6">Sin pagos</td></tr>'}</table>`;
      })
      .join("");
    const moraTxt = [...moraPorMoneda.entries()]
      .filter(([, v]) => v > 0)
      .map(([cur, v]) => `<p>Mora estimada (${esc(cur)}): ${esc(formatCurrency(v, cur))}. Es una estimación y no forma parte del saldo.</p>`)
      .join("");
    w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Estado de cuenta</title>
<style>body{font:13px system-ui,sans-serif;margin:24px;color:#111}h1{font-size:20px}h2{font-size:15px;margin-top:22px}h3{font-size:13px}
table{border-collapse:collapse;width:100%;margin:6px 0}th,td{border:1px solid #bbb;padding:4px 6px;text-align:left}th{background:#eee}</style></head>
<body><h1>Estado de cuenta</h1><p>${esc(name ?? "Cliente")} · al ${esc(fechaLima(today))}</p>${bloques}${moraTxt}</body></html>`);
    w.document.close();
    w.focus();
    w.print();
  }

  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error) return <p className="py-4 text-sm text-rose-400">No se pudo leer el estado de cuenta: {error}</p>;
  if (falta084) {
    return (
      <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        Falta aplicar la migración 084 (pagos protegidos): el estado de cuenta sale del libro de pagos.
      </p>
    );
  }
  if (planes.length === 0) return <p className="py-4 text-sm text-muted-foreground">Sin contratos de cuotas.</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Estado de cuenta al {fechaLima(today)}</p>
        <Button size="sm" variant="outline" onClick={imprimir}>
          <Printer className="h-3.5 w-3.5" /> Imprimir
        </Button>
      </div>

      {planes.map((p) => {
        const cs = cuotas.filter((q) => q.plan_id === p.id);
        const ps = pagos.filter((x) => x.plan_id === p.id);
        const fmt = (n: number | string) => formatCurrency(Number(n), p.currency);
        return (
          <section key={p.id} className="space-y-2 rounded-xl border border-border p-3">
            <h3 className="text-sm font-semibold">
              {p.unit?.code ? `Lote ${p.unit.code}` : "Contrato"} · {fmt(p.total_amount)}
            </h3>
            <ul className="space-y-1 text-xs">
              {cs.map((q) => {
                const s = saldos.get(q.id);
                return (
                  <li key={q.id} className="flex flex-wrap justify-between gap-2">
                    <span>
                      Cuota {q.number} · vence {fechaLima(q.due_date)}
                    </span>
                    <span className="text-muted-foreground">
                      {fmt(q.amount)} · pagado {fmt(s?.paid_so_far ?? 0)} · falta {fmt(s?.remaining ?? 0)} ·{" "}
                      {ESTADO_CUOTA[q.status] ?? q.status}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="border-t border-border pt-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pagos</p>
              {ps.length === 0 ? (
                <p className="text-xs text-muted-foreground">Sin pagos.</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {ps.map((x) => (
                    <li key={x.id} className="flex flex-wrap justify-between gap-2">
                      <span className={x.voided_at ? "line-through text-muted-foreground" : ""}>
                        {fechaLima(x.paid_on)} · cuota {cs.find((q) => q.id === x.installment_id)?.number ?? "—"} · {fmt(x.amount)}
                      </span>
                      <span className="text-muted-foreground">
                        {x.voided_at
                          ? `Anulado: ${x.void_reason}`
                          : [x.method, x.reference && `Op. ${x.reference}`, x.late_fee_at_payment && Number(x.late_fee_at_payment) > 0 && `mora estimada al pago ${fmt(x.late_fee_at_payment)}`]
                              .filter(Boolean)
                              .join(" · ")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        );
      })}

      {[...moraPorMoneda.entries()]
        .filter(([, v]) => v > 0)
        .map(([cur, v]) => (
          <p key={cur} className="text-xs text-amber-400">
            Mora estimada ({cur}): {formatCurrency(v, cur)}. Es una estimación; no forma parte del saldo.
          </p>
        ))}
    </div>
  );
}
