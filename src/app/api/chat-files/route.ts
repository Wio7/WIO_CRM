// ============================================================
// /api/chat-files?p=<ruta> — entrega un archivo privado del chat
//
// Lo pueden abrir:
//   · el cliente dueño del archivo (Bearer con su token de la app);
//   · alguien del equipo de esa cuenta (sesión del CRM, por cookie o
//     Bearer), si la base le deja ver a ese contacto.
// Nadie más: la ruta dice de qué cuenta y de qué contacto es, y eso es lo
// que se compara — nunca lo que el navegador diga ser.
// ============================================================

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { corsPreflight, withCors } from "@/lib/cors";
import { bearerToken } from "@/lib/client-portal/http";
import { resolveClientSession } from "@/lib/client-portal/sessions";
import { getRequestAuth } from "@/lib/supabase/request-auth";
import { BUCKET_CLIENTE, partesDeRuta } from "@/lib/client-portal/files";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const no = (request: Request, status: number) =>
  withCors(request, NextResponse.json({ ok: false }, { status }));

async function puedeVer(request: Request, accountId: string, contactId: string): Promise<boolean> {
  // ¿El cliente mismo? Su token de la app no es un JWT (no lleva puntos).
  const token = bearerToken(request);
  if (token && !token.includes(".")) {
    const s = await resolveClientSession(supabaseAdmin(), token).catch(() => null);
    return !!s && s.accountId === accountId && s.contactId === contactId;
  }

  const { supabase, user } = await getRequestAuth(request);
  if (!user) return false;
  // Con SU cliente de Supabase: si la base le deja ver al contacto, puede
  // ver su archivo.
  const { data } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("account_id", accountId)
    .maybeSingle();
  return !!data;
}

export async function GET(request: Request) {
  const ruta = new URL(request.url).searchParams.get("p") ?? "";
  const partes = partesDeRuta(ruta);
  if (!partes) return no(request, 400);
  if (!(await puedeVer(request, partes.accountId, partes.contactId))) return no(request, 403);

  const { data, error } = await supabaseAdmin().storage.from(BUCKET_CLIENTE).download(ruta);
  if (error || !data) return no(request, 404);

  return withCors(
    request,
    new NextResponse(data, {
      headers: {
        "Content-Type": data.type || "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    }),
  );
}
