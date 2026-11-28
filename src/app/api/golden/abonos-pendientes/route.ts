import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  destinatariosGerencia,
  inicioDiaLima,
  pendientesDesde,
  perfilesCuenta,
  textoAbonosPendientes,
  URL_ABONOS,
} from "@/lib/golden/aviso-abono";
import { notifyUsers } from "@/lib/push/send";

/**
 * Aviso de las 5 pm de Lima (cron 22:00 UTC): si quedan abonos de hoy sin
 * validar, Gerencia recibe cuántos y cuánto espera el más antiguo. No manda
 * datos de clientes. Auth igual que /api/golden/separaciones-por-vencer.
 */
export const maxDuration = 60;

function secretMatches(supplied: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  const headerSecret = process.env.AUTOMATION_CRON_SECRET;
  const vercelSecret = process.env.CRON_SECRET;
  if (!headerSecret && !vercelSecret) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const authorized =
    secretMatches(request.headers.get("x-cron-secret") ?? "", headerSecret) || secretMatches(bearer, vercelSecret);
  if (!authorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = supabaseAdmin();
  const ahora = new Date();
  const grupos = await pendientesDesde(db, inicioDiaLima(ahora));
  if (grupos === "error") {
    console.error("[abonos pendientes] no se pudo leer gerencia_solicitudes");
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  let cuentas = 0;
  let enviados = 0;
  for (const g of grupos) {
    if (g.cantidad <= 0) continue;
    const destinatarios = destinatariosGerencia(await perfilesCuenta(db, g.account_id));
    if (destinatarios.length === 0) continue;
    cuentas += 1;
    const { title, body } = textoAbonosPendientes(g.cantidad, g.masAntiguo, ahora);
    enviados += await notifyUsers(db, { userIds: destinatarios, title, body, url: URL_ABONOS, tag: "abonos-pendientes" });
  }
  return NextResponse.json({ ok: true, cuentas, enviados });
}
