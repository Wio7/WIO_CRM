// ============================================================
// /api/client/benefits — "Mis beneficios" del cliente
//
//   GET Bearer <token> → { ok, codigo, referidos, cupones }
//
// Su código para invitar (se crea la primera vez), a quiénes trajo y en
// qué quedó cada uno, y sus cupones — los de su DNI.
// ============================================================

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { corsPreflight, withCors } from "@/lib/cors";
import { bearerToken } from "@/lib/client-portal/http";
import { resolveClientSession } from "@/lib/client-portal/sessions";
import { codigoDeReferido } from "@/lib/referrals";

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const primerNombre = (n: string | null | undefined) => (n ?? "").trim().split(/\s+/)[0] || "Alguien";

export async function GET(request: Request) {
  const db = supabaseAdmin();
  const s = await resolveClientSession(db, bearerToken(request)).catch(() => null);
  if (!s) return withCors(request, NextResponse.json({ ok: false, reason: "signed_out" }, { status: 401 }));

  const { data: contacto } = await db
    .from("contacts")
    .select("id, account_id, dni")
    .eq("id", s.contactId)
    .maybeSingle();
  if (!contacto) return withCors(request, NextResponse.json({ ok: false, reason: "signed_out" }, { status: 401 }));

  const codigo = await codigoDeReferido(db, contacto);
  if (!codigo) {
    return withCors(request, NextResponse.json({ ok: false, reason: "sin_migracion" }, { status: 503 }));
  }

  const [{ data: referidos }, { data: cupones }] = await Promise.all([
    db
      .from("referrals")
      .select("status, created_at, referido:contacts!referrals_referred_contact_id_fkey(name)")
      .eq("referrer_contact_id", contacto.id)
      .order("created_at", { ascending: false })
      .limit(30),
    contacto.dni
      ? db
          .from("coupons")
          .select("code, kind, value, currency, description, status, expires_at")
          .eq("account_id", contacto.account_id)
          .eq("dni", contacto.dni)
          .in("status", ["activo", "usado"])
          .order("created_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [] }),
  ]);

  return withCors(
    request,
    NextResponse.json({
      ok: true,
      codigo,
      referidos: (referidos ?? []).map((r) => ({
        // Sólo el primer nombre: al que invita le basta para reconocerlo.
        nombre: primerNombre((r.referido as unknown as { name: string | null } | null)?.name),
        estado: r.status,
        desde: r.created_at,
      })),
      cupones: cupones ?? [],
    }),
  );
}
