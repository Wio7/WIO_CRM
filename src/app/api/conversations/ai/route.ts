// ============================================================
// /api/conversations/ai — quién sigue la conversación: la IA o yo
//
//   POST { conversation_id, ia: boolean } → { ok, ia }
//
// Los dos botones del chat. Al tomarla, la IA se calla y el cliente sabe
// con quién habla; al devolverla, la IA vuelve a contestar desde ahora
// (`ai_resumed_at`, migración 056) y también se le avisa al cliente. En
// los dos casos el aviso sale por el canal del cliente: WhatsApp, la app,
// Messenger, Instagram o correo, lo que esté usando.
//
// Corre con la sesión de quien toca el botón, así que la base decide si
// puede: sólo se cambia una conversación que esa persona puede ver (055).
// ============================================================

import { NextResponse } from "next/server";

import { getRequestAuth } from "@/lib/supabase/request-auth";
import { corsPreflight, withCors } from "@/lib/cors";
import { sendMessageToConversation, SendMessageError } from "@/lib/whatsapp/send-message";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const AVISO_ASESOR = (nombre: string) =>
  `${nombre ? `Hola, soy ${nombre}` : "Hola, soy un asesor"} de Golden Habitat 👋 Desde aquí te atiendo yo.`;

const AVISO_IA =
  "Te dejo con la asistente virtual de Golden Habitat, que te responde al instante a cualquier hora. Si necesitas a una persona, dilo y te paso con un asesor. 🙌";

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

  // Con SU cliente: si la base no le deja ver esta conversación, no hay
  // fila que actualizar y se queda en 404.
  const cambios: Record<string, unknown> = ia
    ? { ai_autoreply_disabled: false, ai_resumed_at: new Date().toISOString(), ai_reply_count: 0 }
    : { ai_autoreply_disabled: true };

  let { error } = await supabase
    .from("conversations")
    .update(cambios)
    .eq("id", conversationId)
    .eq("account_id", perfil.account_id);

  // Sin la 056 no existe `ai_resumed_at`: se hace lo que sí se puede.
  if (error && /ai_resumed_at/i.test(error.message)) {
    delete cambios.ai_resumed_at;
    ({ error } = await supabase
      .from("conversations")
      .update(cambios)
      .eq("id", conversationId)
      .eq("account_id", perfil.account_id));
  }
  if (error) {
    console.error("[conversations/ai] update failed:", error.message);
    return withCors(request, NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 }));
  }

  // El aviso al cliente. Si no se puede mandar (ventana de 24 h de
  // WhatsApp cerrada, por ejemplo), el cambio ya quedó hecho igual.
  const nombre = (perfil.full_name as string | null)?.trim().split(/\s+/)[0] ?? "";
  let avisado = true;
  try {
    await sendMessageToConversation(supabase, perfil.account_id as string, {
      conversationId,
      messageType: "text",
      contentText: ia ? AVISO_IA : AVISO_ASESOR(nombre),
    });
  } catch (err) {
    avisado = false;
    if (!(err instanceof SendMessageError)) console.error("[conversations/ai] aviso falló:", err);
  }

  return withCors(request, NextResponse.json({ ok: true, ia, avisado }));
}
