// ============================================================
// /api/client/chat — el chat del cliente, dentro de la app
//
//   GET  Bearer <token> [?desde=<iso>] → { ok, mensajes, asesor }
//   POST Bearer <token> { texto }      → { ok, mensaje }
//
// El cliente escribe aquí y su mensaje aparece en la bandeja del CRM,
// en el mismo hilo que WhatsApp. No abre WhatsApp, no sale de la app y
// no ve ningún número: para él es un chat con Golden, y punto.
//
// Como en /api/client/plan, el service role lee y escribe, y el único
// filtro es el contacto de la sesión. El texto se recorta a 4096
// caracteres (el límite de un mensaje de WhatsApp) para que el día que
// el hilo salga por Meta no se corte a mitad.
// ============================================================

import { NextResponse, after } from "next/server";

import { dispatchInboundToAiReply } from "@/lib/ai/auto-reply";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { corsPreflight, withCors } from "@/lib/cors";
import { bearerToken } from "@/lib/client-portal/http";
import { resolveClientSession } from "@/lib/client-portal/sessions";
import {
  conversacionDelCliente,
  guardarMensajeDelCliente,
  mensajesDelCliente,
} from "@/lib/client-portal/chat";

const LARGO_MAXIMO = 4096;

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

/** La sesión del cliente y su contacto, o la respuesta de error ya armada. */
async function sesionDe(request: Request) {
  const db = supabaseAdmin();
  const session = await resolveClientSession(db, bearerToken(request)).catch((err) => {
    console.error("[client-portal] session lookup failed:", err);
    return undefined;
  });

  if (session === undefined) {
    return {
      error: withCors(
        request,
        NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 }),
      ),
    };
  }
  if (!session) {
    return {
      error: withCors(
        request,
        NextResponse.json({ ok: false, reason: "signed_out" }, { status: 401 }),
      ),
    };
  }

  const { data: contacto } = await db
    .from("contacts")
    .select("id, account_id, name, phone")
    .eq("id", session.contactId)
    .maybeSingle();

  if (!contacto) {
    return {
      error: withCors(
        request,
        NextResponse.json({ ok: false, reason: "signed_out" }, { status: 401 }),
      ),
    };
  }

  return { db, contacto };
}

export async function GET(request: Request) {
  const r = await sesionDe(request);
  if ("error" in r) return r.error;
  const { db, contacto } = r;

  const desde = new URL(request.url).searchParams.get("desde") ?? undefined;

  // Sin conversación todavía no se crea ninguna: abrir el chat y mirar no
  // debería dejar hilos vacíos en la bandeja del asesor. La conversación
  // nace con el primer mensaje.
  const conv = await conversacionDelCliente(db, contacto, false);
  const mensajes = conv ? await mensajesDelCliente(db, conv.id, desde) : [];

  return withCors(request, NextResponse.json({ ok: true, mensajes }));
}

export async function POST(request: Request) {
  const r = await sesionDe(request);
  if ("error" in r) return r.error;
  const { db, contacto } = r;

  const body = await request.json().catch(() => ({}));
  const texto = String(body?.texto ?? "").trim().slice(0, LARGO_MAXIMO);
  if (!texto) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "invalid_input" }, { status: 400 }),
    );
  }

  const mensaje = await guardarMensajeDelCliente(db, contacto, texto);
  if (!mensaje) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 }),
    );
  }

  // La IA 24/7 también contesta en la app, con las mismas reglas que en
  // WhatsApp: sólo mientras ningún asesor haya escrito en el hilo. Va
  // después de responder para que el cliente vea su mensaje al instante.
  after(async () => {
    const [{ data: conv }, { data: cuenta }] = await Promise.all([
      db
        .from("conversations")
        .select("id")
        .eq("contact_id", contacto.id)
        .eq("account_id", contacto.account_id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db.from("accounts").select("owner_user_id").eq("id", contacto.account_id).maybeSingle(),
    ]);
    if (!conv || !cuenta?.owner_user_id) return;
    await dispatchInboundToAiReply({
      accountId: contacto.account_id,
      conversationId: conv.id,
      contactId: contacto.id,
      configOwnerUserId: cuenta.owner_user_id,
    });
  });

  return withCors(request, NextResponse.json({ ok: true, mensaje }));
}
