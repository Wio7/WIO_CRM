// ============================================================
// /api/ai/conocimiento — "Enseñar a mi asistente" desde la app del cliente
//
//   GET                      → { ok, documentos: [{ id, titulo, resumen, actualizado }] }
//   POST { titulo, texto }   → { ok, id, aviso? }      (dueño o administrador)
//   DELETE ?id=<id>          → { ok }                   (dueño o administrador)
//
// Lo mismo que la base de conocimiento del CRM (/api/ai/knowledge), con la
// sesión de la app (Bearer). Para Broker Home (2026-11-21): la IA repetía
// siempre lo mismo porque solo sabía un párrafo del proyecto; Julio carga
// precios, formas de pago, referencias y preguntas frecuentes desde su app.
// Sin llave de embeddings la búsqueda es por palabras, que ya funciona.
// ============================================================

import { NextResponse } from "next/server";

import { getRequestAuth } from "@/lib/supabase/request-auth";
import { corsPreflight, withCors } from "@/lib/cors";
import { loadEmbeddingsKey } from "@/lib/ai/config";
import { ingestDocument } from "@/lib/ai/knowledge";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const responder = (request: Request, cuerpo: Record<string, unknown>, status = 200) =>
  withCors(request, NextResponse.json(cuerpo, { status }));

const MAXIMO_TEXTO = 20_000;

async function quien(request: Request) {
  const { supabase, user } = await getRequestAuth(request);
  if (!user) return { error: responder(request, { ok: false, motivo: "Tu sesión venció. Vuelve a entrar." }, 401) };
  const { data: perfil } = await supabase
    .from("profiles")
    .select("account_id, account_role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!perfil?.account_id) return { error: responder(request, { ok: false, motivo: "Tu usuario no pertenece a ninguna cuenta." }, 403) };
  return {
    supabase,
    userId: user.id,
    accountId: perfil.account_id as string,
    jefe: ["owner", "admin"].includes(perfil.account_role as string),
  };
}

const soloJefe = (request: Request) =>
  responder(request, { ok: false, motivo: "Solo el dueño o un administrador le enseña al asistente." }, 403);

export async function GET(request: Request) {
  const q = await quien(request);
  if ("error" in q) return q.error;
  const { data, error } = await q.supabase
    .from("ai_knowledge_documents")
    .select("id, title, content, updated_at")
    .eq("account_id", q.accountId)
    .order("updated_at", { ascending: false });
  if (error) {
    console.error("[ai/conocimiento GET]", error.message);
    return responder(request, { ok: false, motivo: "No se pudo leer lo que sabe tu asistente." }, 500);
  }
  return responder(request, {
    ok: true,
    documentos: (data ?? []).map((d) => ({
      id: d.id,
      titulo: d.title,
      resumen: String(d.content ?? "").replace(/\s+/g, " ").slice(0, 160),
      actualizado: d.updated_at,
    })),
  });
}

export async function POST(request: Request) {
  const q = await quien(request);
  if ("error" in q) return q.error;
  if (!q.jefe) return soloJefe(request);

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const titulo = String(body.titulo ?? "").trim().slice(0, 200);
  const texto = String(body.texto ?? "").trim();
  if (!titulo || !texto) return responder(request, { ok: false, motivo: "Ponle un título y escribe lo que debe saber." }, 400);
  if (texto.length > MAXIMO_TEXTO) {
    return responder(request, { ok: false, motivo: "Es muy largo: pártelo en varios temas (máx. 20.000 letras cada uno)." }, 400);
  }

  const { data: doc, error } = await q.supabase
    .from("ai_knowledge_documents")
    .insert({ account_id: q.accountId, created_by: q.userId, title: titulo, content: texto })
    .select("id")
    .single();
  if (error || !doc) {
    console.error("[ai/conocimiento POST]", error?.message);
    return responder(request, { ok: false, motivo: "No se pudo guardar." }, 500);
  }

  const { key } = await loadEmbeddingsKey(q.supabase, q.accountId);
  try {
    await ingestDocument(q.supabase, q.accountId, { embeddingsApiKey: key }, doc.id, texto);
  } catch (err) {
    console.error("[ai/conocimiento POST] indexado:", err);
    return responder(request, { ok: true, id: doc.id, aviso: "Guardado. La búsqueda por palabras ya funciona." });
  }
  return responder(request, { ok: true, id: doc.id });
}

export async function DELETE(request: Request) {
  const q = await quien(request);
  if ("error" in q) return q.error;
  if (!q.jefe) return soloJefe(request);
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return responder(request, { ok: false, motivo: "Falta cuál borrar." }, 400);
  const { error } = await q.supabase
    .from("ai_knowledge_documents")
    .delete()
    .eq("account_id", q.accountId)
    .eq("id", id);
  if (error) {
    console.error("[ai/conocimiento DELETE]", error.message);
    return responder(request, { ok: false, motivo: "No se pudo borrar." }, 500);
  }
  return responder(request, { ok: true });
}
