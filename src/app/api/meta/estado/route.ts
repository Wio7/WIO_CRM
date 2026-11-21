// ============================================================
// /api/meta/estado — ¿la cuenta tiene Facebook e Instagram conectados?
//
//   GET → { ok, conectado, paginas: [{ nombre, instagram, mensajes }] }
//
// Para la tarjeta "Facebook e Instagram" de la app del cliente. Nunca
// devuelve tokens. Lo lee cualquier miembro de la cuenta (RLS por cuenta).
// ============================================================

import { NextResponse } from "next/server";

import { getRequestAuth } from "@/lib/supabase/request-auth";
import { corsPreflight, withCors } from "@/lib/cors";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const responder = (request: Request, cuerpo: Record<string, unknown>, status = 200) =>
  withCors(request, NextResponse.json(cuerpo, { status }));

export async function GET(request: Request) {
  const { supabase, user } = await getRequestAuth(request);
  if (!user) return responder(request, { ok: false, motivo: "Tu sesión venció. Vuelve a entrar." }, 401);
  const { data: perfil } = await supabase
    .from("profiles")
    .select("account_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!perfil?.account_id) return responder(request, { ok: false, motivo: "Tu usuario no pertenece a ninguna cuenta." }, 403);

  const [{ data: conexion }, { data: paginas, error }] = await Promise.all([
    supabase.from("meta_connections").select("fb_user_name, connected_at").eq("account_id", perfil.account_id).maybeSingle(),
    supabase
      .from("meta_pages")
      .select("page_name, is_active, instagram_username, messaging_at, last_error")
      .eq("account_id", perfil.account_id)
      .order("page_name"),
  ]);
  if (error) {
    console.error("[meta/estado]", error.message);
    return responder(request, { ok: false, motivo: "No se pudo leer la conexión con Meta." }, 500);
  }
  return responder(request, {
    ok: true,
    conectado: Boolean(conexion),
    conectado_por: conexion?.fb_user_name ?? null,
    paginas: (paginas ?? []).map((p) => ({
      nombre: p.page_name,
      instagram: p.instagram_username ? `@${p.instagram_username}` : null,
      mensajes: Boolean(p.is_active && p.messaging_at),
      error: p.last_error ?? null,
    })),
  });
}
