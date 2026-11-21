// ============================================================
// /api/whatsapp/plantillas — plantillas de WhatsApp desde la app del cliente
//
//   GET  → { ok, plantillas: [{ nombre, categoria, idioma, estado, texto, motivo_rechazo }] }
//   POST { accion: "sincronizar" }                         → { ok, total }
//   POST { accion: "crear", nombre, categoria, texto }     → { ok, estado }
//
// Para Broker Home (2026-11-21): Julio necesita plantillas para retomar
// chats pasadas 24 h y no tenía cómo crearlas sin entrar al CRM. Crear y
// sincronizar reusan las rutas del CRM (`templates/submit` y
// `templates/sync`), que ya aceptan la sesión de la app: aquí solo se
// traduce el formulario simple de la app y se exige dueño o administrador.
// ============================================================

import { NextResponse } from "next/server";

import { getRequestAuth } from "@/lib/supabase/request-auth";
import { corsPreflight, withCors } from "@/lib/cors";
import { POST as enviarPlantilla } from "@/app/api/whatsapp/templates/submit/route";
import { POST as sincronizarPlantillas } from "@/app/api/whatsapp/templates/sync/route";
import { pedidoDePlantilla } from "@/lib/whatsapp/plantilla-simple";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const responder = (request: Request, cuerpo: Record<string, unknown>, status = 200) =>
  withCors(request, NextResponse.json(cuerpo, { status }));

async function quien(request: Request) {
  const { supabase, user } = await getRequestAuth(request);
  if (!user) return { error: responder(request, { ok: false, motivo: "Tu sesión venció. Vuelve a entrar." }, 401) };
  const { data: perfil } = await supabase
    .from("profiles")
    .select("account_id, account_role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!perfil?.account_id) return { error: responder(request, { ok: false, motivo: "Tu usuario no pertenece a ninguna cuenta." }, 403) };
  return { supabase, accountId: perfil.account_id as string, rol: perfil.account_role as string };
}

export async function GET(request: Request) {
  const q = await quien(request);
  if ("error" in q) return q.error;
  const { data, error } = await q.supabase
    .from("message_templates")
    .select("name, category, language, status, body_text, rejection_reason, submission_error")
    .eq("account_id", q.accountId)
    .order("name");
  if (error) {
    console.error("[plantillas] lectura:", error.message);
    return responder(request, { ok: false, motivo: "No se pudieron leer las plantillas." }, 500);
  }
  return responder(request, {
    ok: true,
    plantillas: (data ?? []).map((f) => ({
      nombre: f.name,
      categoria: f.category,
      idioma: f.language || "es",
      estado: String(f.status ?? "").toUpperCase(),
      texto: f.body_text,
      motivo_rechazo: f.rejection_reason || f.submission_error || null,
    })),
  });
}

/** Llama a una ruta del CRM con la misma sesión y devuelve su JSON. */
async function reenviar(
  request: Request,
  ruta: (r: Request) => Promise<Response>,
  cuerpo?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const interna = new Request(request.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: request.headers.get("authorization") ?? "",
      cookie: request.headers.get("cookie") ?? "",
    },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const r = await ruta(interna);
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, json };
}

export async function POST(request: Request) {
  const q = await quien(request);
  if ("error" in q) return q.error;
  if (!["owner", "admin"].includes(q.rol)) {
    return responder(request, { ok: false, motivo: "Solo el dueño o un administrador maneja las plantillas." }, 403);
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  if (body.accion === "sincronizar") {
    const r = await reenviar(request, sincronizarPlantillas);
    if (r.status >= 400) {
      return responder(request, { ok: false, motivo: String(r.json.error ?? "No se pudo sincronizar con Meta.") }, r.status);
    }
    return responder(request, { ok: true, total: r.json.total ?? 0 });
  }

  if (body.accion === "crear") {
    const pedido = pedidoDePlantilla(body);
    if ("error" in pedido) return responder(request, { ok: false, motivo: pedido.error }, 400);
    const r = await reenviar(request, enviarPlantilla, pedido.payload);
    if (r.status >= 400) {
      return responder(request, { ok: false, motivo: String(r.json.error ?? "Meta no aceptó la plantilla.") }, r.status);
    }
    const fila = (r.json.template ?? r.json) as Record<string, unknown>;
    return responder(request, { ok: true, estado: String(fila.status ?? "PENDING").toUpperCase() });
  }

  return responder(request, { ok: false, motivo: "Acción desconocida." }, 400);
}
