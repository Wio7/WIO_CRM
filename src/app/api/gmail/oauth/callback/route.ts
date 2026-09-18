import { NextResponse } from "next/server";

import { requireRole } from "@/lib/auth/account";
import { getBaseUrl } from "@/lib/auth/invitations";
import { verifyState } from "@/lib/meta-leads/oauth";
import { canjearCodigo, cifrar } from "@/lib/gmail";

/**
 * GET /api/gmail/oauth/callback — Google vuelve aquí con el código.
 *
 * Siempre redirige a Configuración → Correo; los errores viajan en
 * `?error=` para que la pantalla los diga.
 */
export async function GET(request: Request) {
  const base = getBaseUrl(request);
  const volver = (extra: string) => NextResponse.redirect(`${base}/settings?tab=email&${extra}`);
  const fallo = (msg: string) => volver(`error=${encodeURIComponent(msg)}`);

  try {
    const url = new URL(request.url);
    const errorGoogle = url.searchParams.get("error");
    if (errorGoogle) return fallo(errorGoogle === "access_denied" ? "Cancelaste el permiso en Google." : errorGoogle);
    const code = url.searchParams.get("code");
    if (!code) return fallo("Google no devolvió un código.");

    const { supabase, accountId, userId } = await requireRole("admin");
    const desdeState = verifyState(url.searchParams.get("state"));
    if (!desdeState || desdeState !== accountId) return fallo("La conexión expiró o empezó en otra cuenta. Intenta de nuevo.");

    const { refreshToken, email } = await canjearCodigo(code, `${base}/api/gmail/oauth/callback`);
    const { error } = await supabase.from("email_accounts").upsert(
      {
        account_id: accountId,
        email,
        refresh_token: cifrar(refreshToken),
        history_id: null,
        connected_by: userId,
        connected_at: new Date().toISOString(),
        last_error: null,
        is_active: true,
      },
      { onConflict: "account_id" },
    );
    if (error) {
      return fallo(/email_accounts|schema cache/i.test(error.message) ? "Falta correr la migración 054." : "No se pudo guardar la conexión.");
    }
    return volver(`connected=${encodeURIComponent(email)}`);
  } catch (err) {
    return fallo(err instanceof Error ? err.message : "No se pudo conectar Gmail.");
  }
}
