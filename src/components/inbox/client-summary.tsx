"use client";

// ============================================================
// Quién es este cliente, en el panel del chat.
//
// Cobranzas atiende a alguien que dice "ya pagué" o "¿cuánto debo?", y
// hasta ahora tenía que irse a otra pantalla a averiguarlo mientras el
// cliente esperaba. Esto pone lo mínimo indispensable al lado del hilo:
// qué compró, cuánto debe, cuánto lleva atrasado y si dejó un voucher
// esperando revisión.
//
// Las cifras salen de `payment_plan_balances` (043), nunca de una suma
// hecha aquí: si esta pantalla calculara por su cuenta, tarde o temprano
// le diría al asesor un saldo distinto al que ve el cliente en su app.
//
// Si el contacto no tiene plan, no se pinta nada: es un interesado, no
// un cliente, y un bloque vacío que diga "sin plan" sólo ocupa sitio.
// ============================================================

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";
import type { PaymentPlan, PaymentPlanBalance } from "@/types";
import { Home, ArrowUpRight, FileClock } from "lucide-react";

interface ClientSummaryProps {
  contactId: string | null;
}

const fecha = (iso: string | null | undefined) =>
  iso
    ? new Date(`${iso}T00:00:00`).toLocaleDateString("es-PE", {
        day: "2-digit",
        month: "short",
      })
    : "—";

export function ClientSummary({ contactId }: ClientSummaryProps) {
  const supabase = createClient();
  const [plan, setPlan] = useState<(PaymentPlan & { unit?: { code: string | null } }) | null>(null);
  const [balance, setBalance] = useState<PaymentPlanBalance | null>(null);
  const [vouchers, setVouchers] = useState(0);

  useEffect(() => {
    // Un flag por efecto: cambiar de chat rápido lanza dos cargas, y sin
    // esto la lenta pisa a la nueva y el asesor ve el saldo del cliente
    // anterior junto al nombre del actual.
    let cancelado = false;

    const vaciar = () => {
      if (cancelado) return;
      setPlan(null);
      setBalance(null);
      setVouchers(0);
    };

    (async () => {
      if (!contactId) {
        vaciar();
        return;
      }

      const { data: p } = await supabase
        .from("payment_plans")
        .select("*, unit:real_estate_units(code, project:real_estate_projects(name))")
        .eq("contact_id", contactId)
        .in("status", ["activo", "pagado"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cancelado) return;
      if (!p) {
        vaciar();
        return;
      }

      const [{ data: b }, { count, error: errVouchers }] = await Promise.all([
        supabase.from("payment_plan_balances").select("*").eq("plan_id", p.id).maybeSingle(),
        supabase
          .from("installments")
          .select("id", { count: "exact", head: true })
          .eq("plan_id", p.id)
          .eq("status", "pendiente")
          .not("voucher_path", "is", null),
      ]);

      if (cancelado) return;
      setPlan(p as PaymentPlan);
      setBalance((b as PaymentPlanBalance) ?? null);
      // Sin la 047 la columna no existe: el resto del resumen vale igual.
      setVouchers(errVouchers ? 0 : count ?? 0);
    })();

    return () => {
      cancelado = true;
    };
  }, [contactId, supabase]);

  if (!plan) return null;

  const unidad = plan.unit as unknown as
    | { code: string | null; project: { name: string } | null }
    | null;
  const atraso = balance?.overdue_count ?? 0;

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-center gap-2">
        <Home className="h-3.5 w-3.5 text-primary" />
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Cliente de Golden
        </h4>
      </div>

      {unidad?.code && (
        <p className="mb-2 text-sm text-foreground">
          {unidad.code}
          {unidad.project?.name && (
            <span className="text-muted-foreground"> · {unidad.project.name}</span>
          )}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Dato
          titulo="Por cobrar"
          valor={formatCurrency(balance?.pending_amount ?? 0, plan.currency)}
        />
        <Dato
          titulo={atraso === 1 ? "1 cuota atrasada" : `${atraso} atrasadas`}
          valor={formatCurrency(balance?.overdue_amount ?? 0, plan.currency)}
          alerta={atraso > 0}
        />
        <Dato titulo="Próxima" valor={fecha(balance?.next_due_date)} />
        <Dato
          titulo="Pagadas"
          valor={`${balance?.paid_count ?? 0} de ${plan.installments_count}`}
        />
      </div>

      {vouchers > 0 && (
        <p className="mt-2 flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">
          <FileClock className="h-3.5 w-3.5" />
          {vouchers === 1
            ? "1 voucher esperando revisión"
            : `${vouchers} vouchers esperando revisión`}
        </p>
      )}

      <Link
        href="/payment-plans"
        className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
      >
        Ver sus cuotas
        <ArrowUpRight className="h-3 w-3" />
      </Link>
    </div>
  );
}

function Dato({
  titulo,
  valor,
  alerta,
}: {
  titulo: string;
  valor: string;
  alerta?: boolean;
}) {
  return (
    <div className="rounded-md bg-muted/40 px-2 py-1.5">
      <p
        className={cn(
          "text-sm font-semibold tabular-nums",
          alerta ? "text-red-400" : "text-foreground",
        )}
      >
        {valor}
      </p>
      <p className="text-[11px] text-muted-foreground">{titulo}</p>
    </div>
  );
}
