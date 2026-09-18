import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { hayGoogle } from "@/lib/gmail";

/**
 * GET    /api/gmail/status → { configurado, conectado, email, ultima, error }
 * DELETE /api/gmail/status → desconecta el buzón (deja de leerlo).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole("admin");
    const { data, error } = await supabase
      .from("email_accounts")
      .select("email, last_sync_at, last_error, is_active")
      .eq("account_id", accountId)
      .maybeSingle();
    return NextResponse.json({
      configurado: hayGoogle(),
      migracion: !error,
      conectado: Boolean(data?.is_active),
      email: data?.email ?? null,
      ultima: data?.last_sync_at ?? null,
      error: data?.last_error ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole("admin");
    const { error } = await supabase.from("email_accounts").delete().eq("account_id", accountId);
    if (error) return NextResponse.json({ error: "No se pudo desconectar." }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
