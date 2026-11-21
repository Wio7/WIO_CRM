// ============================================================
// /api/whatsapp/calidad — semáforo del número de WhatsApp de la cuenta
//
//   GET → { ok, numero, nombre, calidad, semaforo, limite, limite_texto, actualizado }
//
// Para la app de Broker Home (pedido de Julio, 2026-11-21): ver si Meta
// está contenta con el número antes de un envío masivo. Cualquier miembro
// de la cuenta lo puede ver. El token del número se lee con permisos de
// servidor, siempre filtrado por la cuenta del que pregunta, y nunca sale
// de aquí.
// ============================================================

import { NextResponse } from "next/server";

import { getRequestAuth } from "@/lib/supabase/request-auth";
import { corsPreflight, withCors } from "@/lib/cors";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { decrypt } from "@/lib/whatsapp/encryption";
import { META_API_VERSION } from "@/lib/whatsapp/meta-api";
import { limiteEnTexto, semaforoDe } from "@/lib/whatsapp/calidad";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const responder = (request: Request, cuerpo: Record<string, unknown>, status = 200) =>
  withCors(request, NextResponse.json(cuerpo, { status }));

async function graph(path: string, token: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  return (await r.json().catch(() => null)) as Record<string, unknown> | null;
}

export async function GET(request: Request) {
  const { supabase, user } = await getRequestAuth(request);
  if (!user) return responder(request, { ok: false, motivo: "Tu sesión venció. Vuelve a entrar." }, 401);
  const { data: perfil } = await supabase
    .from("profiles")
    .select("account_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!perfil?.account_id) return responder(request, { ok: false, motivo: "Tu usuario no pertenece a ninguna cuenta." }, 403);

  const { data: config } = await supabaseAdmin()
    .from("whatsapp_config")
    .select("phone_number_id, access_token")
    .eq("account_id", perfil.account_id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!config?.phone_number_id || !config.access_token) {
    return responder(request, { ok: false, motivo: "Esta cuenta todavía no tiene un número de WhatsApp conectado." });
  }

  let token: string;
  try {
    token = decrypt(config.access_token as string);
  } catch {
    return responder(request, { ok: false, motivo: "No se pudo leer la conexión del número. Vuelve a conectarlo." });
  }

  const id = config.phone_number_id as string;
  const base = await graph(`${id}?fields=display_phone_number,verified_name,quality_rating`, token);
  if (!base) return responder(request, { ok: false, motivo: "Meta no respondió. Intenta en unos minutos." }, 502);
  // El límite va aparte: Meta lo está moviendo al portafolio y un campo
  // que ya no existe no puede tumbar el semáforo.
  const limite = await graph(`${id}?fields=messaging_limit_tier`, token);

  const calidad = String(base.quality_rating ?? "UNKNOWN").toUpperCase();
  const tier = (limite?.messaging_limit_tier as string | undefined) ?? null;
  return responder(request, {
    ok: true,
    numero: base.display_phone_number ?? null,
    nombre: base.verified_name ?? null,
    calidad,
    semaforo: semaforoDe(calidad),
    limite: tier,
    limite_texto: limiteEnTexto(tier),
    actualizado: new Date().toISOString(),
  });
}
