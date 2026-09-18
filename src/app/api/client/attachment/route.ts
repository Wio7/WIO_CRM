// ============================================================
// /api/client/attachment — el cliente manda una foto o un PDF por el chat
//
//   POST Bearer <token>  multipart { archivo, texto? } → { ok, mensaje }
//
// El archivo va al bucket privado (ver src/lib/client-portal/files.ts) y
// el mensaje entra en su conversación de siempre, marcado "por la app".
// ============================================================

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { corsPreflight, withCors } from "@/lib/cors";
import { bearerToken } from "@/lib/client-portal/http";
import { resolveClientSession } from "@/lib/client-portal/sessions";
import { guardarMensajeDelCliente } from "@/lib/client-portal/chat";
import {
  BUCKET_CLIENTE,
  MAXIMO_ADJUNTO,
  TIPOS_ADJUNTO,
  extensionDe,
  rutaDeAdjunto,
  urlDeAdjunto,
} from "@/lib/client-portal/files";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const responder = (request: Request, cuerpo: object, status = 200) =>
  withCors(request, NextResponse.json(cuerpo, { status }));

export async function POST(request: Request) {
  const db = supabaseAdmin();
  const session = await resolveClientSession(db, bearerToken(request)).catch(() => null);
  if (!session) return responder(request, { ok: false, reason: "signed_out" }, 401);

  const form = await request.formData().catch(() => null);
  const archivo = form?.get("archivo");
  const texto = String(form?.get("texto") ?? "").trim().slice(0, 1000);
  if (!(archivo instanceof File) || archivo.size === 0) {
    return responder(request, { ok: false, reason: "invalid_input" }, 400);
  }
  if (archivo.size > MAXIMO_ADJUNTO) return responder(request, { ok: false, reason: "muy_pesado" }, 413);
  if (archivo.type && !TIPOS_ADJUNTO.includes(archivo.type)) {
    return responder(request, { ok: false, reason: "tipo_no_valido" }, 415);
  }

  const esPdf = archivo.type === "application/pdf" || /\.pdf$/i.test(archivo.name);
  const ruta = rutaDeAdjunto(session.accountId, session.contactId, extensionDe(archivo.type, archivo.name));
  const { error: errSubida } = await db.storage
    .from(BUCKET_CLIENTE)
    .upload(ruta, archivo, {
      contentType: archivo.type || (esPdf ? "application/pdf" : "image/jpeg"),
      upsert: false,
    });
  if (errSubida) {
    console.error("[client-portal] attachment upload failed:", errSubida.message);
    return responder(request, { ok: false, reason: "server_error" }, 500);
  }

  const { data: contacto } = await db
    .from("contacts")
    .select("id, account_id, name, phone")
    .eq("id", session.contactId)
    .maybeSingle();
  if (!contacto) return responder(request, { ok: false, reason: "signed_out" }, 401);

  const nombre = archivo.name ? archivo.name.slice(0, 120) : "";
  const mensaje = await guardarMensajeDelCliente(
    db,
    contacto,
    texto || (esPdf ? nombre || "Documento" : ""),
    { tipo: esPdf ? "document" : "image", url: urlDeAdjunto(ruta) },
  );
  if (!mensaje) {
    await db.storage.from(BUCKET_CLIENTE).remove([ruta]).catch(() => {});
    return responder(request, { ok: false, reason: "server_error" }, 500);
  }
  return responder(request, { ok: true, mensaje });
}
