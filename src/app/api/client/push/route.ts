// ============================================================
// /api/client/push — el celular del cliente, apuntado
//
//   POST   Bearer <token> { endpoint, p256dh, auth, user_agent? }
//   DELETE Bearer <token> { endpoint }
//
// El cliente no tiene sesión de base con la que guardar nada, así que su
// suscripción entra por aquí y se guarda contra su contacto (migración
// 048). Un mismo `endpoint` que vuelve —el teléfono que se resuscribe, o
// que cambió de dueño— se repunta al contacto actual en vez de fallar.
// ============================================================

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { corsPreflight, withCors } from "@/lib/cors";
import { bearerToken } from "@/lib/client-portal/http";
import { resolveClientSession } from "@/lib/client-portal/sessions";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

export async function POST(request: Request) {
  const db = supabaseAdmin();
  const session = await resolveClientSession(db, bearerToken(request)).catch(() => null);
  if (!session) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "signed_out" }, { status: 401 }),
    );
  }

  const body = await request.json().catch(() => ({}));
  const endpoint = String(body?.endpoint ?? "");
  const p256dh = String(body?.p256dh ?? "");
  const auth = String(body?.auth ?? "");
  if (!endpoint || !p256dh || !auth) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "invalid_input" }, { status: 400 }),
    );
  }

  const { error } = await db.from("client_push_subscriptions").upsert(
    {
      contact_id: session.contactId,
      account_id: session.accountId,
      endpoint,
      p256dh,
      auth,
      user_agent: String(body?.user_agent ?? "").slice(0, 400) || null,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "endpoint" },
  );

  if (error) {
    console.error("[client-portal] push subscribe failed:", error.message);
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 }),
    );
  }
  return withCors(request, NextResponse.json({ ok: true }));
}

export async function DELETE(request: Request) {
  const db = supabaseAdmin();
  const session = await resolveClientSession(db, bearerToken(request)).catch(() => null);
  if (!session) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "signed_out" }, { status: 401 }),
    );
  }

  const body = await request.json().catch(() => ({}));
  const endpoint = String(body?.endpoint ?? "");
  if (endpoint) {
    // Por contacto además de por endpoint: nadie puede desapuntar el
    // teléfono de otro aunque conozca su dirección de push.
    await db
      .from("client_push_subscriptions")
      .delete()
      .eq("endpoint", endpoint)
      .eq("contact_id", session.contactId);
  }
  return withCors(request, NextResponse.json({ ok: true }));
}
