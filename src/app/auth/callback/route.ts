// ============================================================
// GET /auth/callback?code=…&next=/join/<token>
//
// The browser client signs people up and resets passwords with PKCE:
// Supabase verifies the email link and comes back here with a one-time
// `code`, which has to be traded for a session. Nothing did that
// before, so confirming a signup landed on the invitation signed out
// and asked to create the account again, and "forgot password" pointed
// at a route that didn't exist.
// ============================================================

import { NextResponse, type NextRequest } from "next/server";

import { inviteTokenFromPath, safeNext } from "@/lib/auth/safe-next";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNext(searchParams.get("next"), origin);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
    console.error("[auth/callback] code exchange failed:", error.message);
  }

  // Supabase already verified the address before redirecting, so a
  // failed exchange usually means the link was opened in a different
  // browser than the one that asked for it (signed up on the computer,
  // opened the email on the phone). The account is fine: sign in.
  const login = new URL("/login", origin);
  const invite = inviteTokenFromPath(next);
  if (invite) login.searchParams.set("invite", invite);
  const aviso = next.startsWith("/reset-password")
    ? "reset"
    : code
      ? "confirmado"
      : "enlace";
  login.searchParams.set("aviso", aviso);
  return NextResponse.redirect(login);
}
