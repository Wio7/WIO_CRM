// ============================================================
// /api/client/voucher — el cliente manda la foto de su pago
//
//   POST Bearer <token>  multipart/form-data
//        { foto, cuota, monto?, metodo?, operacion? }
//     → { ok: true, cuota } | { ok: false, reason }
//
// Hasta ahora el voucher viajaba por WhatsApp y alguien lo apuntaba a
// mano en un cuaderno. Aquí la foto queda pegada a la cuota que paga, y
// cobranzas la ve en la pantalla de Cuotas con un clic.
//
// Lo que NO hace, a propósito: dar la cuota por pagada. La cuota sigue
// 'pendiente' con su `voucher_path` puesto, que es como la 047 dice "en
// revisión". El saldo del cliente no baja hasta que alguien de cobranzas
// lo confirma — si bajara solo, bastaría subir cualquier foto para
// aparecer al día.
//
// La foto va al bucket PRIVADO `client-docs` (042). No hay URL pública
// de un voucher en ninguna parte: se abre firmada y caduca.
// ============================================================

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { corsPreflight, withCors } from "@/lib/cors";
import { bearerToken } from "@/lib/client-portal/http";
import { resolveClientSession } from "@/lib/client-portal/sessions";
import { guardarMensajeDelCliente } from "@/lib/client-portal/chat";
import { falta047 } from "@/lib/payment-plans/migration-047";

const MAXIMO_BYTES = 8 * 1024 * 1024;
const TIPOS = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const extensionDe = (tipo: string, nombre: string) => {
  const porNombre = /\.([a-z0-9]{2,5})$/i.exec(nombre || "")?.[1];
  if (porNombre) return porNombre.toLowerCase();
  if (tipo === "application/pdf") return "pdf";
  return tipo.split("/")[1] || "jpg";
};

export async function POST(request: Request) {
  const db = supabaseAdmin();
  const session = await resolveClientSession(db, bearerToken(request)).catch(() => null);
  if (!session) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "signed_out" }, { status: 401 }),
    );
  }

  const form = await request.formData().catch(() => null);
  const foto = form?.get("foto");
  const cuotaId = String(form?.get("cuota") ?? "");
  if (!(foto instanceof File) || foto.size === 0 || !cuotaId) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "invalid_input" }, { status: 400 }),
    );
  }
  if (foto.size > MAXIMO_BYTES) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "muy_pesada" }, { status: 413 }),
    );
  }
  if (foto.type && !TIPOS.includes(foto.type)) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "tipo_no_valido" }, { status: 415 }),
    );
  }

  // La cuota tiene que ser de un plan de ESTE contacto. Es el único
  // permiso que hay que comprobar, y se comprueba contra la sesión, no
  // contra nada que haya mandado el navegador.
  const { data: cuota } = await db
    .from("installments")
    .select("id, number, amount, status, plan:payment_plans!inner(id, contact_id, currency)")
    .eq("id", cuotaId)
    .maybeSingle();

  const plan = cuota?.plan as unknown as { contact_id: string | null; currency: string } | null;
  if (!cuota || plan?.contact_id !== session.contactId) {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "no_es_tuya" }, { status: 404 }),
    );
  }
  if (cuota.status !== "pendiente") {
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "ya_pagada" }, { status: 409 }),
    );
  }

  const ruta = `account-${session.accountId}/vouchers/${session.contactId}/${crypto.randomUUID()}.${extensionDe(
    foto.type,
    foto.name,
  )}`;

  const { error: errSubida } = await db.storage
    .from("client-docs")
    .upload(ruta, foto, { contentType: foto.type || "image/jpeg", upsert: false });

  if (errSubida) {
    console.error("[client-portal] voucher upload failed:", errSubida.message);
    return withCors(
      request,
      NextResponse.json({ ok: false, reason: "server_error" }, { status: 500 }),
    );
  }

  const metodo = String(form?.get("metodo") ?? "").trim().slice(0, 60);
  const operacion = String(form?.get("operacion") ?? "").trim().slice(0, 60);
  const monto = Number(form?.get("monto") ?? 0) || null;

  const { error: errCuota } = await db
    .from("installments")
    .update({
      voucher_path: ruta,
      paid_method: metodo || null,
      paid_reference: operacion || null,
    })
    .eq("id", cuota.id);

  if (errCuota) {
    // Sin la 047 no hay dónde guardar la ruta. Se borra la foto en vez de
    // dejarla huérfana en el bucket, y se avisa con nombre y apellido.
    await db.storage.from("client-docs").remove([ruta]).catch(() => {});
    console.error("[client-portal] voucher save failed:", errCuota.message);
    return withCors(
      request,
      NextResponse.json(
        { ok: false, reason: falta047(errCuota) ? "falta_migracion" : "server_error" },
        { status: 500 },
      ),
    );
  }

  // Y que aparezca en el chat, que es donde cobranzas está mirando.
  const { data: contacto } = await db
    .from("contacts")
    .select("id, account_id, name, phone")
    .eq("id", session.contactId)
    .maybeSingle();

  if (contacto) {
    const partes = [
      `Envié el voucher de la cuota ${cuota.number}`,
      monto ? `por ${monto}` : "",
      metodo ? `(${metodo})` : "",
      operacion ? `Op. ${operacion}` : "",
    ].filter(Boolean);
    await guardarMensajeDelCliente(db, contacto, partes.join(" "));
  }

  return withCors(request, NextResponse.json({ ok: true, cuota: cuota.number }));
}
