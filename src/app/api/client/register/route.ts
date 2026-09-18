// ============================================================
// /api/client/register — un interesado nuevo se registra desde la app
//
//   POST { name, phone, dni } → { ok, token, expires_at, client }
//
// Público. Crea el contacto (lead_source 'app') y abre su sesión como
// visitante, que ve la portada de venta. Si el celular ya está en el CRM
// no crea nada: responde `ya_existe` (que entre con su DNI) o
// `ya_existe_sin_dni` (que pida acceso por WhatsApp). Ver
// registerVisitor en src/lib/client-portal/sessions.ts.
// ============================================================

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { corsPreflight, withCors } from "@/lib/cors";
import { clientIp } from "@/lib/client-portal/http";
import { registerVisitor } from "@/lib/client-portal/sessions";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const STATUS: Record<string, number> = {
  invalid_input: 400,
  ya_existe: 409,
  ya_existe_sin_dni: 409,
  dni_en_uso: 409,
  locked: 429,
  sin_cuenta: 503,
  no_match: 401,
  server_error: 500,
};

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

export async function POST(request: Request) {
  const rafaga = checkRateLimit(`client-register:${clientIp(request)}`, {
    limit: 5,
    windowMs: 10 * 60_000,
  });
  if (!rafaga.success) return withCors(request, rateLimitResponse(rafaga));

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const texto = (v: unknown) => (typeof v === "string" ? v : "");

  const result = await registerVisitor(supabaseAdmin(), {
    name: texto(body?.name),
    phone: texto(body?.phone),
    dni: texto(body?.dni),
    ref: texto(body?.ref),
    ip: clientIp(request),
    userAgent: request.headers.get("user-agent"),
  });

  if (result.ok) return withCors(request, NextResponse.json(result));
  const response = NextResponse.json(result, { status: STATUS[result.reason] ?? 400 });
  if (result.reason === "locked") {
    response.headers.set("Retry-After", String(result.retry_after_seconds));
  }
  return withCors(request, response);
}
