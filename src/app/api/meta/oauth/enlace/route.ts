// ============================================================
// /api/meta/oauth/enlace — "Conectar Facebook e Instagram" desde la app
//
//   GET ?volver=<url de la app> → { ok, url }
//
// La app del cliente (Broker Home) no tiene la cookie del CRM, así que no
// puede usar /api/meta/oauth/start. Pide aquí, con su sesión (Bearer), el
// enlace de Facebook; la dirección de vuelta y quién conectó viajan
// firmados en el `state`, y el callback devuelve a la app.
// Solo dueño o administrador, y solo de vuelta a un origen permitido.
// ============================================================

import { NextResponse } from "next/server";

import { getRequestAuth } from "@/lib/supabase/request-auth";
import { corsPreflight, origenPermitido, withCors } from "@/lib/cors";
import { getBaseUrl } from "@/lib/auth/invitations";
import { buildAuthorizeUrl } from "@/lib/meta-leads/oauth";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const responder = (request: Request, cuerpo: Record<string, unknown>, status = 200) =>
  withCors(request, NextResponse.json(cuerpo, { status }));

/** La dirección de vuelta, solo si es de un origen permitido (https). */
export function volverValido(volver: string | null): string | null {
  if (!volver) return null;
  try {
    const u = new URL(volver);
    if (u.protocol !== "https:" && u.hostname !== "localhost") return null;
    return origenPermitido(u.origin) ? u.toString() : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const { supabase, user } = await getRequestAuth(request);
  if (!user) return responder(request, { ok: false, motivo: "Tu sesión venció. Vuelve a entrar." }, 401);
  const { data: perfil } = await supabase
    .from("profiles")
    .select("account_id, account_role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!perfil?.account_id) return responder(request, { ok: false, motivo: "Tu usuario no pertenece a ninguna cuenta." }, 403);
  if (!["owner", "admin"].includes(perfil.account_role as string)) {
    return responder(request, { ok: false, motivo: "Solo el dueño o un administrador conecta Facebook e Instagram." }, 403);
  }
  if (!process.env.META_APP_ID) {
    return responder(request, { ok: false, motivo: "Falta configurar META_APP_ID en el servidor." }, 500);
  }

  const volver = volverValido(new URL(request.url).searchParams.get("volver"));
  if (!volver) return responder(request, { ok: false, motivo: "Dirección de vuelta no permitida." }, 400);

  const redirectUri = `${getBaseUrl(request)}/api/meta/oauth/callback`;
  const url = buildAuthorizeUrl(perfil.account_id as string, redirectUri, { volver, userId: user.id });
  return responder(request, { ok: true, url });
}
