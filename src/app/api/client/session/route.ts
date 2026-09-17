// ============================================================
// /api/client/session — clients sign into the Golden App
//
//   POST   { phone, dni } → { ok, token, expires_at, client }
//          Public. The pair must match a contact of an account with
//          `client_portal_enabled` (migration 045). A wrong DNI and an
//          unknown phone get the same answer, so the form can't be used
//          to find out who is a client. 5 failures lock the phone for
//          15 minutes (and warn the advisor); 30 tries lock the IP.
//   DELETE Bearer <token> → signs that session out.
//
// Called cross-origin from the Golden App: answers with CORS for the
// origins in APP_CORS_ORIGINS.
// ============================================================

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { corsPreflight, withCors } from "@/lib/cors";
import { bearerToken, clientIp } from "@/lib/client-portal/http";
import { revokeClientSession, signInClient } from "@/lib/client-portal/sessions";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const STATUS = {
  invalid_input: 400,
  no_match: 401,
  locked: 429,
  server_error: 500,
} as const;

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

export async function POST(request: Request) {
  // Cheap per-instance guard in front of the database-backed locks.
  const burst = checkRateLimit(`client-signin:${clientIp(request)}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (!burst.success) return withCors(request, rateLimitResponse(burst));

  const body = (await request.json().catch(() => null)) as {
    phone?: unknown;
    dni?: unknown;
  } | null;

  const result = await signInClient(supabaseAdmin(), {
    phone: typeof body?.phone === "string" ? body.phone : "",
    dni: typeof body?.dni === "string" ? body.dni : "",
    ip: clientIp(request),
    userAgent: request.headers.get("user-agent"),
  });

  if (result.ok) return withCors(request, NextResponse.json(result));

  const response = NextResponse.json(result, { status: STATUS[result.reason] });
  if (result.reason === "locked") {
    response.headers.set("Retry-After", String(result.retry_after_seconds));
  }
  return withCors(request, response);
}

export async function DELETE(request: Request) {
  try {
    await revokeClientSession(supabaseAdmin(), bearerToken(request));
  } catch (err) {
    console.error("[client-portal] sign-out failed:", err);
  }
  return withCors(request, NextResponse.json({ ok: true }));
}
