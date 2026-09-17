// ============================================================
// /api/client/plan — what the client owes, from the client's side
//
//   GET Bearer <token> → { ok, plan, cuotas } | { ok: true, plan: null }
//
// The Golden App's buyer view asks this and nothing else: one plan, its
// schedule, and the balance the CRM already computes. A visitor (no plan)
// gets `plan: null` rather than a 404, because "you have no instalments
// yet" is a normal answer, not an error.
//
// Why a server route instead of RLS like the inbox does: after migration
// 041 a client is not a member of the account, so the client's token can
// read nothing directly. Here the service role reads, and the ONLY filter
// that matters is `contact_id = session.contactId` — never a value that
// arrived in the request. A client can therefore never ask for someone
// else's plan, not even by guessing its id.
//
// Amounts are sent as numbers and dates as plain `YYYY-MM-DD`; the app
// formats them. `atrasada` and `en_revision` are derived here so the two
// screens can't disagree about what "late" means.
// ============================================================

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { corsPreflight, withCors } from "@/lib/cors";
import { bearerToken } from "@/lib/client-portal/http";
import { resolveClientSession } from "@/lib/client-portal/sessions";
import { falta047 } from "@/lib/payment-plans/migration-047";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

/** Hoy en Lima, como `YYYY-MM-DD`, para comparar con `due_date`. */
function hoyEnLima(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

interface CuotaFila {
  number: number;
  amount: number | string;
  due_date: string;
  status: string;
  paid_at: string | null;
  paid_amount: number | string | null;
  paid_method?: string | null;
  paid_reference?: string | null;
  voucher_path?: string | null;
}

export async function GET(request: Request) {
  const db = supabaseAdmin();

  const session = await resolveClientSession(db, bearerToken(request)).catch((err) => {
    console.error("[client-portal] session lookup failed:", err);
    return undefined;
  });

  if (session === undefined) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 }),
    );
  }
  if (!session) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "signed_out" }, { status: 401 }),
    );
  }

  // El plan vivo del cliente. Si tuviera más de uno (dos lotes), gana el
  // más reciente: es el que está pagando ahora.
  const { data: plan, error } = await db
    .from("payment_plans")
    .select(
      "id, currency, total_amount, down_payment, installments_count, monthly_amount, due_day, first_due_date, status, unit:real_estate_units(code, manzana, project:real_estate_projects(name))",
    )
    .eq("contact_id", session.contactId)
    .in("status", ["activo", "pagado"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[client-portal] plan lookup failed:", error.message);
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 }),
    );
  }

  if (!plan) {
    return withCors(request, NextResponse.json({ ok: true, plan: null, cuotas: [] }));
  }

  // Con el detalle del pago (047) si existe, y sin él si la migración
  // todavía no se corrió: el cliente tiene que poder ver lo que debe
  // aunque el CRM vaya una migración atrás.
  const CON_047 =
    "number, amount, due_date, status, paid_at, paid_amount, paid_method, paid_reference, voucher_path";
  const SIN_047 = "number, amount, due_date, status, paid_at, paid_amount";

  const [{ data: balance }, cuotasRes] = await Promise.all([
    db.from("payment_plan_balances").select("*").eq("plan_id", plan.id).maybeSingle(),
    db.from("installments").select(CON_047).eq("plan_id", plan.id).order("number"),
  ]);

  let cuotas = cuotasRes.data as CuotaFila[] | null;
  if (cuotasRes.error) {
    if (!falta047(cuotasRes.error)) {
      console.error("[client-portal] installments lookup failed:", cuotasRes.error.message);
      return withCors(
        request,
        NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 }),
      );
    }
    const reintento = await db
      .from("installments")
      .select(SIN_047)
      .eq("plan_id", plan.id)
      .order("number");
    cuotas = reintento.data as CuotaFila[] | null;
  }

  const hoy = hoyEnLima();
  const unidad = plan.unit as unknown as
    | { code: string | null; manzana: string | null; project: { name: string } | null }
    | null;

  return withCors(
    request,
    NextResponse.json({
      ok: true,
      plan: {
        id: plan.id,
        currency: plan.currency,
        total_amount: Number(plan.total_amount),
        down_payment: Number(plan.down_payment),
        installments_count: plan.installments_count,
        monthly_amount: Number(plan.monthly_amount),
        due_day: plan.due_day,
        status: plan.status,
        unidad: unidad?.code ?? null,
        manzana: unidad?.manzana ?? null,
        proyecto: unidad?.project?.name ?? null,
        saldo: {
          pagado: Number(balance?.paid_amount ?? 0),
          pagadas: Number(balance?.paid_count ?? 0),
          por_cobrar: Number(balance?.pending_amount ?? 0),
          pendientes: Number(balance?.pending_count ?? 0),
          atrasadas: Number(balance?.overdue_count ?? 0),
          atrasado: Number(balance?.overdue_amount ?? 0),
          proxima_fecha: balance?.next_due_date ?? null,
        },
      },
      cuotas: (cuotas ?? []).map((c) => ({
        numero: c.number,
        monto: Number(c.amount),
        vence: c.due_date,
        estado: c.status,
        atrasada: c.status === "pendiente" && c.due_date < hoy,
        // Subió su voucher y todavía nadie lo aprueba. Sigue debiendo:
        // el saldo no baja hasta que alguien de cobranzas lo confirma.
        en_revision: c.status === "pendiente" && !!c.voucher_path,
        pagada_el: c.paid_at ?? null,
        pagado: c.paid_amount === null || c.paid_amount === undefined ? null : Number(c.paid_amount),
        metodo: c.paid_method ?? null,
        operacion: c.paid_reference ?? null,
      })),
    }),
  );
}
