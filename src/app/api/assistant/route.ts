// ============================================================
// /api/assistant — el hilo de cada persona con el Asistente Golden
//
//   GET     → { ok, mensajes }             los últimos 60, del más viejo al más nuevo
//   POST    { texto } → { ok, pregunta, respuesta }
//   DELETE  → { ok }                        empezar de cero
//
// Acepta la sesión del dashboard (cookies) o la del asesor en la Golden
// App (Bearer). Todo corre con SU cliente de Supabase: el asistente sólo
// ve lo que esa persona ya puede ver (RLS), y el hilo es sólo suyo
// (`assistant_messages`, migración 050).
// ============================================================

import { NextResponse } from "next/server";

import { getRequestAuth } from "@/lib/supabase/request-auth";
import { corsPreflight, withCors } from "@/lib/cors";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { responder, ErrorAsistente } from "@/lib/assistant/run";

const LARGO_MAXIMO = 2000;

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const faltaTabla = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "PGRST205" || e.code === "42P01" || /schema cache|does not exist/i.test(e.message ?? ""));

async function quien(request: Request) {
  const { supabase, user } = await getRequestAuth(request);
  if (!user) {
    return { error: NextResponse.json({ ok: false, reason: "signed_out" }, { status: 401 }) };
  }
  const { data: perfil } = await supabase
    .from("profiles")
    .select("account_id, account_role, full_name, email, area")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!perfil?.account_id || perfil.account_role === "viewer") {
    return { error: NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 }) };
  }
  return {
    ctx: {
      db: supabase,
      userId: user.id,
      accountId: perfil.account_id as string,
      rol: perfil.account_role as string,
      area: (perfil.area as string | null) ?? null,
      nombre: ((perfil.full_name as string) || (perfil.email as string) || "").split(" ")[0] || "equipo",
    },
  };
}

export async function GET(request: Request) {
  const r = await quien(request);
  if ("error" in r) return withCors(request, r.error!);
  const { ctx } = r;

  const { data, error } = await ctx.db
    .from("assistant_messages")
    .select("id, role, content, actions, created_at")
    .eq("user_id", ctx.userId)
    .order("created_at", { ascending: false })
    .limit(60);

  if (error) {
    return withCors(
      request,
      NextResponse.json(
        { ok: false, reason: faltaTabla(error) ? "sin_migracion" : "server_error" },
        { status: faltaTabla(error) ? 503 : 500 },
      ),
    );
  }
  return withCors(request, NextResponse.json({ ok: true, mensajes: (data ?? []).reverse() }));
}

export async function POST(request: Request) {
  const r = await quien(request);
  if ("error" in r) return withCors(request, r.error!);
  const { ctx } = r;

  const limite = checkRateLimit(`assistant:${ctx.userId}`, { limit: 20, windowMs: 60_000 });
  if (!limite.success) return withCors(request, rateLimitResponse(limite));

  const body = await request.json().catch(() => ({}));
  const texto = String(body?.texto ?? "").trim().slice(0, LARGO_MAXIMO);
  if (!texto) {
    return withCors(request, NextResponse.json({ ok: false, reason: "invalid_input" }, { status: 400 }));
  }

  const { data: previos, error: errPrevios } = await ctx.db
    .from("assistant_messages")
    .select("role, content")
    .eq("user_id", ctx.userId)
    .order("created_at", { ascending: false })
    .limit(16);
  if (errPrevios && faltaTabla(errPrevios)) {
    return withCors(request, NextResponse.json({ ok: false, reason: "sin_migracion" }, { status: 503 }));
  }

  const { data: pregunta, error: errPregunta } = await ctx.db
    .from("assistant_messages")
    .insert({ account_id: ctx.accountId, user_id: ctx.userId, role: "user", content: texto })
    .select("id, role, content, actions, created_at")
    .single();
  if (errPregunta) {
    console.error("[assistant] could not store the question:", errPregunta.message);
    return withCors(request, NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 }));
  }

  let texto_respuesta: string;
  let acciones: unknown[] = [];
  try {
    const r2 = await responder(
      ctx,
      ((previos ?? []) as { role: "user" | "assistant"; content: string }[]).reverse(),
      texto,
    );
    texto_respuesta = r2.texto;
    acciones = r2.acciones;
  } catch (err) {
    const codigo = err instanceof ErrorAsistente ? err.codigo : "proveedor";
    console.error("[assistant] failed:", err);
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: codigo, pregunta }, { status: codigo === "sin_llave" ? 503 : 502 }),
    );
  }

  const { data: respuesta } = await ctx.db
    .from("assistant_messages")
    .insert({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      role: "assistant",
      content: texto_respuesta,
      actions: acciones.length ? acciones : null,
    })
    .select("id, role, content, actions, created_at")
    .single();

  return withCors(
    request,
    NextResponse.json({
      ok: true,
      pregunta,
      respuesta: respuesta ?? {
        id: `tmp-${Date.now()}`,
        role: "assistant",
        content: texto_respuesta,
        actions: acciones,
        created_at: new Date().toISOString(),
      },
    }),
  );
}

export async function DELETE(request: Request) {
  const r = await quien(request);
  if ("error" in r) return withCors(request, r.error!);
  const { ctx } = r;
  const { error } = await ctx.db.from("assistant_messages").delete().eq("user_id", ctx.userId);
  if (error) {
    return withCors(request, NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 }));
  }
  return withCors(request, NextResponse.json({ ok: true }));
}
