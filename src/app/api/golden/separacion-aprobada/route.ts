// ============================================================
// /api/golden/separacion-aprobada — "Lote separado", a todo el equipo
//
//   POST Bearer <sesión del CRM de quien aprobó>
//        { solicitud_id, nombre_proyecto? }
//     → { ok: true, enviados, duplicado? } | { ok: false, reason }
//
// La aprobación vive en la base del catálogo (otra base); las
// suscripciones push y las claves VAPID, aquí. Para que nadie pueda
// disparar avisos falsos, el cuerpo NO trae lote ni asesor: sólo el id
// de la solicitud. El servidor:
//   1. exige una sesión del CRM de un miembro (no "solo lectura");
//   2. le pregunta al catálogo si esa solicitud está APROBADA y es
//      reciente (función gh_aviso_separacion, sin datos del cliente);
//   3. reserva el aviso en golden_separacion_avisos (migración 088):
//      un solo aviso por solicitud, aunque la llamen diez veces;
//   4. arma él mismo el texto y avisa a todo el equipo de la cuenta.
// Si no salió a ningún celular, libera la reserva para poder reintentar.
// ============================================================

import { NextResponse } from "next/server";

import { corsPreflight, withCors } from "@/lib/cors";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  armarAvisoSeparacion,
  consultarSeparacionAprobada,
  esUuid,
  solicitudReciente,
} from "@/lib/golden/aviso-separacion";
import { notifyTeam } from "@/lib/push/send";
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

  const limite = checkRateLimit(`golden-separacion-aprobada:${user.id}`, { limit: 10, windowMs: 60_000 });
  if (!limite.success) return withCors(request, rateLimitResponse(limite));

  const body = await request.json().catch(() => ({}));
  const solicitudId = body?.solicitud_id;
  if (!esUuid(solicitudId)) return responder(request, { ok: false, reason: "invalid_input" }, 400);

  const consulta = await consultarSeparacionAprobada(solicitudId);
  if (consulta.estado === "sin_config") return responder(request, { ok: false, reason: "not_configured" }, 503);
  if (consulta.estado === "error") return responder(request, { ok: false, reason: "catalog_unavailable" }, 502);
  if (consulta.estado === "no_aprobada") return responder(request, { ok: false, reason: "not_approved" }, 409);
  if (!solicitudReciente(consulta.solicitud.resuelta)) {
    return responder(request, { ok: false, reason: "too_old" }, 409);
  }

  const db = supabaseAdmin();
  const accountId = perfil.account_id as string;

  // Candado de idempotencia: la clave primaria deja pasar a uno solo.
  const { error: choque } = await db
    .from("golden_separacion_avisos")
    .insert({ solicitud_id: solicitudId, account_id: accountId, enviado_por: user.id });
  if (choque) {
    if (choque.code === "23505") return responder(request, { ok: true, enviados: 0, duplicado: true });
    console.error("[golden/separacion-aprobada] no se pudo reservar:", choque.message);
    return responder(request, { ok: false, reason: "server_error" }, 500);
  }

  const { proyecto, lote, asesor } = consulta.solicitud;
  const aviso = armarAvisoSeparacion({
    proyecto,
    nombreProyecto: typeof body?.nombre_proyecto === "string" ? body.nombre_proyecto : "",
    lote,
    asesor,
  });

  let enviados = 0;
  try {
    enviados = await notifyTeam(db, { accountId, ...aviso });
  } catch (err) {
    console.error("[golden/separacion-aprobada] no se pudo avisar:", (err as Error).message);
  }
  if (enviados === 0) {
    // Nadie lo recibió (sin VAPID, sin suscripciones, error): se libera para reintentar.
    await db.from("golden_separacion_avisos").delete().eq("solicitud_id", solicitudId);
  }
  return responder(request, { ok: true, enviados });
}
