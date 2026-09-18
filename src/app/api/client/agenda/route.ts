// ============================================================
// /api/client/agenda — el cliente elige día y hora
//
//   GET  Bearer <token> → { ok, dias, citas }
//   POST Bearer <token> { starts_at, kind? } → { ok, cita }
//   DELETE Bearer <token> { id } → { ok }
//
// Le enseña la agenda de QUIEN le toca: cobranzas si ya paga cuotas,
// ventas si todavía mira, y su asesor de siempre si ya tiene uno. El
// cliente no elige persona — elige hora, que es lo único que le importa.
//
// La hora que manda el navegador se vuelve a comprobar aquí contra la
// disponibilidad real antes de guardar. Si no, bastaría con inventarse un
// `starts_at` para meterse en la agenda de alguien un domingo a las 3 de
// la mañana. Y el choque de dos personas reservando a la vez lo corta el
// índice único de la 049, no esta comprobación.
// ============================================================

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { corsPreflight, withCors } from "@/lib/cors";
import { bearerToken } from "@/lib/client-portal/http";
import { resolveClientSession } from "@/lib/client-portal/sessions";
import { guardarMensajeDelCliente } from "@/lib/client-portal/chat";
import { diasLibres, quienAtiende, PASO_MIN } from "@/lib/agenda/slots";
import { notifyConversation } from "@/lib/push/send";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const TIPOS = ["videollamada", "visita", "llamada"];

/** La sala de la cita: del contacto, no del nombre, y siempre la misma. */
const salaDe = (contactId: string) => `golden-${contactId.replace(/-/g, "").slice(0, 18)}`;

const hora = (iso: string) =>
  new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

async function sesion(request: Request) {
  const db = supabaseAdmin();
  const s = await resolveClientSession(db, bearerToken(request)).catch(() => null);
  if (!s) {
    return {
      error: withCors(
        request,
        NextResponse.json({ ok: false, reason: "signed_out" }, { status: 401 }),
      ),
    };
  }
  return { db, s };
}

export async function GET(request: Request) {
  const r = await sesion(request);
  if ("error" in r) return r.error;
  const { db, s } = r;

  const equipo = await quienAtiende(db, s.accountId, s.contactId);
  const [dias, { data: citas }] = await Promise.all([
    diasLibres(db, s.accountId, equipo),
    db
      .from("appointments")
      .select("id, starts_at, minutes, kind, status, room")
      .eq("contact_id", s.contactId)
      .eq("status", "agendada")
      .gte("starts_at", new Date(Date.now() - 60 * 60_000).toISOString())
      .order("starts_at"),
  ]);

  return withCors(
    request,
    NextResponse.json({
      ok: true,
      dias,
      citas: (citas ?? []).map((c) => ({
        id: c.id,
        starts_at: c.starts_at,
        minutos: c.minutes,
        tipo: c.kind,
        sala: c.room,
      })),
    }),
  );
}

export async function POST(request: Request) {
  const r = await sesion(request);
  if ("error" in r) return r.error;
  const { db, s } = r;

  const body = await request.json().catch(() => ({}));
  const cuando = String(body?.starts_at ?? "");
  const tipo = TIPOS.includes(String(body?.kind)) ? String(body.kind) : "videollamada";
  if (!cuando || Number.isNaN(Date.parse(cuando))) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "invalid_input" }, { status: 400 }),
    );
  }

  // La hora tiene que seguir libre AHORA, y ser una de las que se le
  // ofrecieron: se recalcula, no se confía en lo que llegó.
  const equipo = await quienAtiende(db, s.accountId, s.contactId);
  const dias = await diasLibres(db, s.accountId, equipo);
  const tramo = dias
    .flatMap((d) => d.tramos)
    .find((t) => Date.parse(t.starts_at) === Date.parse(cuando));

  if (!tramo) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "hora_ocupada" }, { status: 409 }),
    );
  }

  const { data: cita, error } = await db
    .from("appointments")
    .insert({
      account_id: s.accountId,
      contact_id: s.contactId,
      user_id: tramo.user_id,
      starts_at: tramo.starts_at,
      minutes: PASO_MIN,
      kind: tipo,
      room: tipo === "videollamada" ? salaDe(s.contactId) : null,
      created_by: "cliente",
    })
    .select("id, starts_at, minutes, kind, room")
    .single();

  if (error) {
    // 23505 es el índice único de la 049: alguien tomó esa hora entre que
    // se la enseñamos y la tocó.
    const ocupada = (error as { code?: string }).code === "23505";
    console.error("[client-portal] booking failed:", error.message);
    return withCors(
      request,
      NextResponse.json(
        { ok: false, reason: ocupada ? "hora_ocupada" : "server_error" },
        { status: ocupada ? 409 : 500 },
      ),
    );
  }

  // Que quede en el chat y que le suene a quien la va a atender: una cita
  // que sólo vive en una tabla es una cita que alguien se pierde.
  const { data: contacto } = await db
    .from("contacts")
    .select("id, account_id, name, phone")
    .eq("id", s.contactId)
    .maybeSingle();

  if (contacto) {
    await guardarMensajeDelCliente(
      db,
      contacto,
      `Agendé una ${tipo} para el ${hora(cita.starts_at)}.`,
    );
    const { data: conv } = await db
      .from("conversations")
      .select("id")
      .eq("contact_id", s.contactId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (conv) {
      await notifyConversation(db, {
        accountId: s.accountId,
        conversationId: conv.id,
        assignedAgentId: tramo.user_id,
        title: "Nueva cita",
        body: `${contacto.name || contacto.phone}: ${tipo} el ${hora(cita.starts_at)}`,
      }).catch(() => { /* el aviso puede fallar; la cita ya está */ });
    }
  }

  return withCors(
    request,
    NextResponse.json({
      ok: true,
      cita: {
        id: cita.id,
        starts_at: cita.starts_at,
        minutos: cita.minutes,
        tipo: cita.kind,
        sala: cita.room,
      },
    }),
  );
}

export async function DELETE(request: Request) {
  const r = await sesion(request);
  if ("error" in r) return r.error;
  const { db, s } = r;

  const body = await request.json().catch(() => ({}));
  const id = String(body?.id ?? "");
  if (!id) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "invalid_input" }, { status: 400 }),
    );
  }

  // Por contacto además de por id: nadie cancela la cita de otro.
  const { error } = await db
    .from("appointments")
    .update({ status: "cancelada" })
    .eq("id", id)
    .eq("contact_id", s.contactId);

  if (error) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 }),
    );
  }
  return withCors(request, NextResponse.json({ ok: true }));
}
