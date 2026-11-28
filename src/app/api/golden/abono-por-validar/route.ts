// ============================================================
// /api/golden/abono-por-validar — aviso al celular de Gerencia apenas
// Cobranzas manda un abono a validar (lib/golden/aviso-abono.ts).
//
//   POST Bearer <sesión del CRM de quien mandó el abono>
//        { solicitud_id }
//     → { ok: true, enviados } | { ok: false, reason }
//
// El cuerpo solo trae el id. El servidor lee la solicitud con el cliente de
// servicio y exige: misma cuenta, kind validacion_abono, pendiente, creada
// por quien llama y hace menos de 10 minutos. El texto sale de la base.
// ============================================================

import { NextResponse } from "next/server";

import { corsPreflight, withCors } from "@/lib/cors";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  destinatariosGerencia,
  esUuidAbono,
  leerSolicitudAbono,
  perfilesCuenta,
  solicitudReciente,
  textoAvisoAbono,
  URL_ABONOS,
} from "@/lib/golden/aviso-abono";
import { notifyUsers } from "@/lib/push/send";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { getRequestAuth } from "@/lib/supabase/request-auth";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const responder = (request: Request, cuerpo: object, status = 200) =>
  withCors(request, NextResponse.json(cuerpo, { status }));

export async function POST(request: Request) {
  const { supabase, user } = await getRequestAuth(request);
  if (!user) return responder(request, { ok: false, reason: "signed_out" }, 401);

  const { data: perfil } = await supabase
    .from("profiles")
    .select("account_id, account_role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!perfil?.account_id || perfil.account_role === "viewer") {
    return responder(request, { ok: false, reason: "forbidden" }, 403);
  }

  const limite = checkRateLimit(`golden-abono-por-validar:${user.id}`, { limit: 20, windowMs: 60_000 });
  if (!limite.success) return withCors(request, rateLimitResponse(limite));

  const body = await request.json().catch(() => ({}));
  const solicitudId = body?.solicitud_id;
  if (!esUuidAbono(solicitudId)) return responder(request, { ok: false, reason: "invalid_input" }, 400);

  const db = supabaseAdmin();
  const s = await leerSolicitudAbono(db, solicitudId);
  if (s === "error") return responder(request, { ok: false, reason: "unavailable" }, 502);
  if (!s) return responder(request, { ok: false, reason: "not_found" }, 404);
  const aplica =
    s.account_id === perfil.account_id &&
    s.kind === "validacion_abono" &&
    s.estado === "pendiente" &&
    s.solicitado_por === user.id &&
    solicitudReciente(s.created_at, new Date());
  if (!aplica) return responder(request, { ok: false, reason: "not_applicable" });

  const destinatarios = destinatariosGerencia(await perfilesCuenta(db, s.account_id), user.id);
  const { title, body: texto } = textoAvisoAbono(s);
  const enviados = await notifyUsers(db, {
    userIds: destinatarios,
    title,
    body: texto,
    url: URL_ABONOS,
    tag: `abono-${s.id}`,
  });
  return responder(request, { ok: true, enviados });
}
