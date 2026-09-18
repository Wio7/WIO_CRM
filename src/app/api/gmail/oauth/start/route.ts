import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { getBaseUrl } from "@/lib/auth/invitations";
import { signState } from "@/lib/meta-leads/oauth";
import { hayGoogle, urlDeAutorizacion } from "@/lib/gmail";

/**
 * GET /api/gmail/oauth/start  (admin+)
 *
 * "Conectar Gmail": firma la cuenta en `state` y manda a la pantalla de
 * permisos de Google. La contraseña se escribe en google.com, nunca aquí.
 */
export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole("admin");
    const base = getBaseUrl(request);
    if (!hayGoogle()) {
      return NextResponse.redirect(
        `${base}/settings?tab=email&error=${encodeURIComponent("Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el servidor.")}`,
      );
    }
    return NextResponse.redirect(urlDeAutorizacion(signState(accountId), `${base}/api/gmail/oauth/callback`));
  } catch (err) {
    return toErrorResponse(err);
  }
}
