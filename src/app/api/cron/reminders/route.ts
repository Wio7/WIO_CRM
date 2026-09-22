// ============================================================
// /api/cron/reminders — "tu cita es en una hora" y "tu cuota vence"
//
//   GET|POST ?secret=<CRON_SECRET>  (o Authorization: Bearer <CRON_SECRET>)
//
// Avisa dos veces, a los dos lados: al cliente en su celular (migración
// 048) y a quien la va a atender (039). Una hora antes para que se
// acomode, y media hora antes para que se conecte.
//
// Hay dos marcas de tiempo y no una (`reminded_60`, `reminded_30`) porque
// son dos avisos distintos: si el que corre esto se retrasa y salta el de
// la hora, el de la media hora todavía tiene que salir.
//
// Cada aviso se marca ANTES de mandarse. Si la notificación falla, se
// pierde un aviso; si se marcara después y el proceso se cortara a mitad,
// el cliente recibiría el mismo aviso en cada pasada. Molestar de más es
// peor que avisar de menos.
//
// Esto necesita que algo lo llame cada pocos minutos. Vercel Hobby sólo
// permite un cron diario, así que en producción lo llama un pinger
// externo (cron-job.org o similar) con el secreto en la URL.
//
// Para configurarlo sin disparar avisos de verdad:
//   GET ...?secret=<CRON_SECRET>&comprobar=1
// responde si el secreto coincide y no toca nada.
// ============================================================

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { notifyClient, notifyConversation } from "@/lib/push/send";
import { nombreDeCita, tituloDeCita } from "@/lib/agenda/tipos";
import { recordatoriosDeCuotas } from "@/lib/payment-plans/reminders";
import { sincronizarCorreos } from "@/lib/gmail";
import { seguimientosPendientes } from "@/lib/ai/seguimiento";

/** Ventana alrededor del objetivo, para que un pinger flojo no lo salte. */
const MARGEN_MIN = 12;

const enMinutos = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

const horaDe = (iso: string) =>
  new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

interface Cita {
  id: string;
  account_id: string;
  contact_id: string | null;
  user_id: string;
  starts_at: string;
  kind: string;
  contacts: { name: string | null; phone: string | null } | null;
}

async function avisar(db: SupabaseClient, cita: Cita, cuanto: "una hora" | "media hora") {
  const cuando = horaDe(cita.starts_at);
  const quien = cita.contacts?.name || cita.contacts?.phone || "tu cliente";

  if (cita.contact_id) {
    await notifyClient(db, {
      contactId: cita.contact_id,
      title: "Golden Habitat",
      body: `Tu ${nombreDeCita(cita.kind)} es en ${cuanto}, a las ${cuando}.`,
    }).catch((err) => console.error("[cron] client reminder failed:", err));

    const { data: conv } = await db
      .from("conversations")
      .select("id")
      .eq("contact_id", cita.contact_id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (conv) {
      await notifyConversation(db, {
        accountId: cita.account_id,
        conversationId: conv.id,
        assignedAgentId: cita.user_id,
        title: `${tituloDeCita(cita.kind)} en ${cuanto}`,
        body: `${quien}, a las ${cuando}.`,
      }).catch((err) => console.error("[cron] agent reminder failed:", err));
    }
  }
}

async function tanda(
  db: SupabaseClient,
  minutos: 60 | 30,
  columna: "reminded_60" | "reminded_30",
): Promise<number> {
  const { data, error } = await db
    .from("appointments")
    .select("id, account_id, contact_id, user_id, starts_at, kind, contacts(name, phone)")
    .eq("status", "agendada")
    .is(columna, null)
    .gte("starts_at", enMinutos(minutos - MARGEN_MIN))
    .lte("starts_at", enMinutos(minutos + MARGEN_MIN))
    .limit(200);

  if (error) {
    console.error("[cron] reminders lookup failed:", error.message);
    return 0;
  }

  const citas = (data ?? []) as unknown as Cita[];
  for (const cita of citas) {
    await db
      .from("appointments")
      .update({ [columna]: new Date().toISOString() })
      .eq("id", cita.id);
    await avisar(db, cita, minutos === 60 ? "una hora" : "media hora");
  }
  return citas.length;
}

async function correr(request: Request) {
  const url = new URL(request.url);
  const secreto = process.env.CRON_SECRET;
  // Un espacio o un salto de línea de más al pegar el valor en Vercel
  // deja el cron en 401 para siempre, y desde fuera es indistinguible de
  // no haberlo puesto. Se recortan los dos lados: nadie quiere un
  // secreto que empiece por espacio.
  const esperado = (secreto ?? "").trim();
  const dado = (url.searchParams.get("secret")
    || (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "")).trim();

  // Comprobación de instalación: dice si el secreto es correcto SIN
  // mandarle nada a ningún cliente. Es lo que se usa para configurar el
  // pinger sin disparar avisos de verdad, y lo que permite averiguar por
  // qué falla sin tener que adivinar.
  if (url.searchParams.get("comprobar") === "1") {
    return NextResponse.json({
      ok: esperado.length > 0 && dado === esperado,
      hay_secreto_en_el_servidor: esperado.length > 0,
      // Nunca el valor, sólo su forma: suficiente para ver un espacio de
      // más o un copiado a medias, inútil para nadie más.
      largo_esperado: esperado.length,
      largo_recibido: dado.length,
      coincide: esperado.length > 0 && dado === esperado,
      nota: "Esto no manda ningún aviso. Quita &comprobar=1 para que el cron trabaje de verdad.",
    });
  }

  if (!esperado || dado !== esperado) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const db = supabaseAdmin();
  const [una, media] = [await tanda(db, 60, "reminded_60"), await tanda(db, 30, "reminded_30")];
  // Y las cuotas (052): tres días antes, el día y tres días después.
  const cuotas = await recordatoriosDeCuotas(db).catch((err) => {
    console.error("[cron] cuota reminders failed:", err);
    return { enviados: 0, omitidos: "error" };
  });
  // Y el correo (054): lo nuevo de cada buzón de Gmail conectado.
  const correo = await sincronizarCorreos(db).catch((err) => {
    console.error("[cron] gmail sync failed:", err);
    return { nuevos: 0 };
  });
  // Y los que dejaron de contestar (059): a la hora, a las tres, a las
  // seis y una última vez antes de que se cierre la ventana de 24 h.
  const seguimiento = await seguimientosPendientes(db).catch((err) => {
    console.error("[cron] seguimiento failed:", err);
    return { escritos: 0, avisados: 0, motivo: "error" };
  });
  return NextResponse.json({
    ok: true,
    avisados: { una_hora: una, media_hora: media, cuotas },
    correo,
    seguimiento,
  });
}

export async function GET(request: Request) {
  return correr(request);
}

export async function POST(request: Request) {
  return correr(request);
}
