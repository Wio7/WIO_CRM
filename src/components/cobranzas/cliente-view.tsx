"use client";

// Ficha de un cliente dentro de la app de Cobranzas: sus contratos (con la
// ficha del plan: pagos en partes y adelantos), el estado de cuenta
// imprimible, "Registrar gestión", "Pasar a legal" y "Enviar a postventa".
// Todo reutiliza los componentes del ERP; aquí solo se arma la pantalla.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ClipboardList, Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/currency";
import { buildDebtors, fechaLima, hoyLima, inResolution, type OverdueInstallment } from "@/lib/collections";
import type { PaymentPlanBalance } from "@/types";
import { Button } from "@/components/ui/button";
import { AccountStatement } from "@/components/collections/account-statement";
import { CollectionActionDialog } from "@/components/collections/collection-action-dialog";
import { useCollectionsPaths } from "@/components/collections/base-path";
import { SendHandoffButton } from "@/components/handoffs/send-handoff-button";
import { PaymentPlanDetail } from "@/components/payment-plans/payment-plan-detail";
import { useAuth } from "@/hooks/use-auth";

interface Contacto {
  id: string;
  name: string | null;
  phone: string | null;
  dni: string | null;
}
interface PlanFila {
  id: string;
  status: string;
  currency: string;
  installments_count: number;
  unit: { code: string | null; project: { name: string | null } | null } | null;
}

const CHUNK = 100;

export function ClienteView({ contactId }: { contactId: string }) {
  const paths = useCollectionsPaths();
  const { accountId } = useAuth();
  const hoy = useMemo(() => hoyLima(), []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contacto, setContacto] = useState<Contacto | null>(null);
  const [planes, setPlanes] = useState<PlanFila[]>([]);
  const [saldos, setSaldos] = useState<Map<string, PaymentPlanBalance>>(new Map());
  // Contrato en causal de resolución (mismo criterio que la lista de morosos).
  const [planLegal, setPlanLegal] = useState<string | null>(null);
  const [fichaPlan, setFichaPlan] = useState<string | null>(null);
  const [gestion, setGestion] = useState(false);
  const [recarga, setRecarga] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      const [c, p, b] = await Promise.all([
        supabase.from("contacts").select("id, name, phone, dni").eq("id", contactId).maybeSingle(),
        supabase
          .from("payment_plans")
          .select("id, status, currency, installments_count, unit:real_estate_units(code, project:real_estate_projects(name))")
          .eq("contact_id", contactId)
          .order("created_at", { ascending: false }),
        supabase.from("payment_plan_balances").select("*").eq("contact_id", contactId),
      ]);
      const filas = (p.data ?? []) as unknown as PlanFila[];

      // Cuotas vencidas de este cliente, con la misma consulta que la lista de morosos.
      const vencidas: OverdueInstallment[] = [];
      let errCuotas: string | null = null;
      const ids = filas.map((f) => f.id);
      for (let i = 0; i < ids.length; i += CHUNK) {
        const { data, error: e } = await supabase
          .from("installments")
          .select(
            "id, plan_id, number, amount, due_date, voucher_path, plan:payment_plans(id, currency, status, contact:contacts(id, name, phone, dni), unit:real_estate_units(code, manzana, project:real_estate_projects(name)))",
          )
          .in("plan_id", ids.slice(i, i + CHUNK))
          .eq("status", "pendiente")
          .lt("due_date", hoy);
        if (e) {
          errCuotas = e.message;
          break;
        }
        vencidas.push(...((data ?? []) as unknown as OverdueInstallment[]));
      }
      let umbrales = { installments: 0, days: 0 };
      if (accountId) {
        const { data: r } = await supabase
          .from("accounts")
          .select("resolution_installments, resolution_days")
          .eq("id", accountId)
          .maybeSingle();
        if (r) umbrales = { installments: Number(r.resolution_installments) || 0, days: Number(r.resolution_days) || 0 };
      }
      if (cancelled) return;
      setError(c.error?.message ?? p.error?.message ?? b.error?.message ?? errCuotas);
      setContacto((c.data as Contacto | null) ?? null);
      setPlanes(filas);
      setSaldos(new Map(((b.data ?? []) as PaymentPlanBalance[]).map((x) => [x.plan_id, x])));
      const enCausal = buildDebtors(vencidas, hoy, new Map()).find((d) => inResolution(d, umbrales));
      setPlanLegal(enCausal?.worstPlan?.planId ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId, hoy, accountId, recarga]);

  const recargar = useCallback(() => setRecarga((n) => n + 1), []);

  return (
    <div className="space-y-6">
      <div>
        <Link href={paths.base} className="inline-flex min-h-8 items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Cuotas y morosos
        </Link>
        <h1 className="text-2xl font-semibold">{contacto?.name ?? (loading ? "Cargando..." : "Cliente")}</h1>
        {contacto && (
          <p className="text-sm text-muted-foreground">
            {contacto.phone ?? "Sin teléfono"}
            {contacto.dni ? ` · DNI ${contacto.dni}` : ""}
          </p>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <p className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm">No se pudo cargar: {error}</p>
      ) : !contacto ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No encontramos a este cliente, o no tienes acceso a él.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setGestion(true)}>
              <ClipboardList className="h-4 w-4" /> Registrar gestión
            </Button>
            {planLegal && <SendHandoffButton kind="pase_legal" entityId={planLegal} />}
            <SendHandoffButton kind="postventa_desde_cobranzas" entityId={contactId} />
          </div>

          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Contratos</h2>
            {planes.length === 0 ? (
              <p className="text-sm text-muted-foreground">Este cliente no tiene planes de pago.</p>
            ) : (
              <ul className="space-y-2">
                {planes.map((pl) => {
                  const s = saldos.get(pl.id);
                  return (
                    <li key={pl.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3">
                      <div className="text-sm">
                        <p className="font-medium">
                          {pl.unit?.code ?? "Sin lote"}
                          <span className="ml-2 text-xs font-normal text-muted-foreground">{pl.unit?.project?.name ?? ""}</span>
                        </p>
                        {s ? (
                          <p className="text-xs text-muted-foreground">
                            {s.paid_count} de {pl.installments_count} cuotas pagadas · saldo{" "}
                            {formatCurrency(Number(s.pending_amount) || 0, s.currency)}
                            {s.overdue_count > 0 ? ` · ${s.overdue_count} vencida${s.overdue_count === 1 ? "" : "s"}` : ""}
                            {s.next_due_date ? ` · próxima ${fechaLima(s.next_due_date)}` : ""}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">{pl.installments_count} cuotas</p>
                        )}
                      </div>
                      <Button variant="outline" size="sm" onClick={() => setFichaPlan(pl.id)}>
                        Ficha del plan
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Estado de cuenta</h2>
            <AccountStatement contactId={contactId} contactName={contacto.name} />
          </section>
        </>
      )}

      <PaymentPlanDetail planId={fichaPlan} onOpenChange={(o) => !o && setFichaPlan(null)} onChanged={recargar} />

      {gestion && contacto && (
        <CollectionActionDialog
          open
          onOpenChange={(o) => !o && setGestion(false)}
          contactId={contactId}
          contactName={contacto.name ?? "Cliente"}
          today={hoy}
          onSaved={() => {}}
          conTraspasos
        />
      )}
    </div>
  );
}
