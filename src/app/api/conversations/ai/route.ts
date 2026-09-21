// ============================================================
// /api/conversations/ai — quién sigue la conversación: la IA o yo
//
//   POST { conversation_id, ia: boolean } → { ok, ia, avisado, motivo? }
//
// Los dos botones del chat. Al tomarla, la IA se calla y el cliente sabe
// con quién habla; al devolverla, la IA vuelve a contestar desde ahora
// (`ai_resumed_at`, migración 056) y también se le avisa al cliente. En
// los dos casos el aviso sale por el canal del cliente: WhatsApp, la app,
// Messenger, Instagram o correo, lo que esté usando.
//
// ORDEN IMPORTANTE al devolvérsela a la IA: el aviso lo manda el asesor,
// así que es un mensaje `sender_type='agent'`. La regla de la 041 dice
// que la IA calla en cuanto el equipo escribe, y `ai_resumed_at` es la
// raya a partir de la cual eso cuenta. Si la raya se pusiera ANTES de
// mandar el aviso, el propio aviso quedaría después de la raya y volvería
// a callar a la IA en el acto — que es exactamente lo que pasaba. Por eso
// la raya se corre hasta la hora del aviso una vez enviado.
//
// Corre con la sesión de quien toca el botón, así que la base decide si
// puede: sólo se cambia una conversación que esa persona puede ver (055).
// ============================================================

import { NextResponse, after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getRequestAuth } from "@/lib/supabase/request-auth";
import { corsPreflight, withCors } from "@/lib/cors";
import { sendMessageToConversation, SendMessageError } from "@/lib/whatsapp/send-message";
import { retomarConLaIa } from "@/lib/ai/retomar";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const AVISO_ASESOR = (nombre: string) =>
  `${nombre ? `Hola, soy ${nombre}` : "Hola, soy un asesor"} de Golden Habitat 👋 Desde aquí te atiendo yo.`;

const AVISO_IA =
  "Te dejo con la asistente virtual de Golden Habitat, que te responde al instante a cualquier hora. Si necesitas a una persona, dilo y te paso con un asesor. 🙌";

/** La columna `ai_resumed_at` no existe todavía (056 sin correr). */
const faltaColumna = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === "42703" || error.code === "PGRST204" || /ai_resumed_at/i.test(error.message ?? ""));

/**
 * Corre la raya hasta el mensaje de aviso recién guardado. Se usa su
 * `created_at` real —el del reloj de la base, no el de este servidor— para
 * que el filtro `created_at > ai_resumed_at` lo deje fuera con certeza,
 * aunque los dos relojes no estén sincronizados al milisegundo.
 */
async function correrLaRaya(
  db: SupabaseClient,
  conversationId: string,
  accountId: string,
  messageId: string | null,
): Promise<void> {
  let cuando: string | null = null;
  if (messageId) {
    const { data } = await db.from("messages").select("created_at").eq("id", messageId).maybeSingle();
    cuando = (data?.created_at as string | undefined) ?? null;
  }
  const { error } = await db
    .from("conversations")
    .update({ ai_resumed_at: cuando ?? new Date().toISOString() })
    .eq("id", conversationId)
    .eq("account_id", accountId);
  if (error && !faltaColumna(error)) {
    console.error("[conversations/ai] no se pudo correr ai_resumed_at:", error.message);
  }
}

export async function POST(request: Request) {
  const { supabase, user } = await getRequestAuth(request);
  if (!user) {
    return withCors(request, NextResponse.json({ ok: false, reason: "signed_out" }, { status: 401 }));
  }

  const body = await request.json().catch(() => ({}));
  const conversationId = String(body?.conversation_id ?? "");
  const ia = Boolean(body?.ia);
  if (!conversationId) {
    return withCors(request, NextResponse.json({ ok: false, reason: "invalid_input" }, { status: 400 }));
  }

  const { data: perfil } = await supabase
    .from("profiles")
    .select("account_id, account_role, full_name")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!perfil?.account_id || perfil.account_role === "viewer") {
    return withCors(request, NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 }));
  }
  const accountId = perfil.account_id as string;

  // Con SU cliente: si la base no le deja ver esta conversación, no hay
  // fila que actualizar y no se cambia nada.
  const cambios: Record<string, unknown> = ia
    ? { ai_autoreply_disabled: false, ai_reply_count: 0, ai_resumed_at: new Date().toISOString() }
    : { ai_autoreply_disabled: true };

  let { error } = await supabase
    .from("conversations")
    .update(cambios)
    .eq("id", conversationId)
    .eq("account_id", accountId);

  // Sin la 056 no existe `ai_resumed_at`: se hace lo que sí se puede.
  if (error && faltaColumna(error)) {
    delete cambios.ai_resumed_at;
    ({ error } = await supabase
      .from("conversations")
      .update(cambios)
      .eq("id", conversationId)
      .eq("account_id", accountId));
  }
  if (error) {
    console.error("[conversations/ai] update failed:", error.message);
    return withCors(request, NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 }));
  }

  // El aviso al cliente. Si no se puede mandar (ventana de 24 h de
  // WhatsApp cerrada, por ejemplo), el cambio ya quedó hecho igual y se
  // devuelve el motivo para poder decírselo al asesor.
  const nombre = (perfil.full_name as string | null)?.trim().split(/\s+/)[0] ?? "";
  let avisado = true;
  let motivo: string | undefined;
  let mensajeDelAviso: string | null = null;
  try {
    const r = await sendMessageToConversation(supabase, accountId, {
      conversationId,
      messageType: "text",
      contentText: ia ? AVISO_IA : AVISO_ASESOR(nombre),
    });
    mensajeDelAviso = r.messageId ?? null;
  } catch (err) {
    avisado = false;
    motivo = err instanceof SendMessageError ? err.message : "No se pudo entregar el aviso.";
    if (!(err instanceof SendMessageError)) console.error("[conversations/ai] aviso falló:", err);
  }

  // Ya con el aviso guardado, la raya se corre hasta él: si no, el propio
  // aviso —que es un mensaje del equipo— volvería a callar a la IA.
  if (ia) {
    await correrLaRaya(supabase, conversationId, accountId, mensajeDelAviso);
    // Y la IA retoma la conversación ella misma, sin esperar a que el
    // cliente vuelva a escribir: si nadie dice nada, el hilo se muere
    // justo donde el asesor lo dejó. Va en `after()` para que el botón
    // responda al instante — generar el mensaje tarda unos segundos.
    after(async () => {
      await retomarConLaIa({ accountId, conversationId });
    });
  }

  return withCors(request, NextResponse.json({ ok: true, ia, avisado, ...(motivo ? { motivo } : {}) }));
}
