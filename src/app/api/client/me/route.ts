// ============================================================
// /api/client/me — who the client session belongs to
//
//   GET Bearer <token> → { ok, client, expires_at }
//
// The Golden App calls it on start: a session revoked by the client,
// or by an advisor changing the DNI (migration 045), answers 401 and
// the app signs out. Later portal routes (plan, payments) resolve the
// session the same way and filter by its contact only.
// ============================================================

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { corsPreflight, withCors } from "@/lib/cors";
import { bearerToken } from "@/lib/client-portal/http";
import { resolveClientSession } from "@/lib/client-portal/sessions";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

export async function GET(request: Request) {
  const session = await resolveClientSession(supabaseAdmin(), bearerToken(request)).catch(
    (err) => {
      console.error("[client-portal] session lookup failed:", err);
      return undefined;
    },
  );

  if (session === undefined) {
    return withCors(request, NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 }));
  }
  if (!session) {
    return withCors(request, NextResponse.json({ ok: false, reason: "signed_out" }, { status: 401 }));
  }
  return withCors(
    request,
    NextResponse.json({ ok: true, client: session.client, expires_at: session.expiresAt }),
  );
}
