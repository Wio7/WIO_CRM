// ============================================================
// /api/invitations/[token]/enter
//
// One-screen onboarding for Golden Habitat's team. The invitee opens
// /join/<token> on their phone, types a name and a password, and lands
// inside the Golden App already signed in — no confirmation email, no
// "accept" button, no second login.
//
//   GET  — public. What the join form needs to render: account, role,
//          expiry, and the email/name the inviter typed (the token
//          holder is the person being invited, so echoing them back is
//          fine; the plaintext token never touches the DB).
//   POST — public. { mode: 'create' | 'login', email?, password,
//          full_name? }
//            1. The invite must be open (not used, not expired) BEFORE
//               anything is created, so a spent link can't mint users.
//            2. create → a confirmed user. The link itself is the
//               proof: an email invite fixes the address; a WhatsApp
//               link lets the person type theirs (the form shows it
//               back before submitting).
//               Email already taken:
//                 · the invitee Supabase pre-created for this same email
//                   invite and who never signed in (so never set a
//                   password) → set the password now;
//                 · anyone else → try the typed password as a login, and
//                   answer `existing_account` if it isn't theirs.
//            3. Sign in with a stateless client and redeem as that user
//               (redeem_invitation checks auth.uid()).
//            4. Return that session. It is a NEW session, separate from
//               any cookie session in this browser, so the Golden App
//               owns its refresh token and nobody else rotates it.
//
// Rate limits reuse the peek/redeem buckets (per IP). Supabase also
// throttles password sign-ins on its side.
// ============================================================

import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { hashInviteToken } from "@/lib/auth/invitations";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const MAX_NAME_LEN = 80;

interface InviteRow {
  id: string;
  role: "owner" | "admin" | "agent" | "viewer";
  email: string | null;
  label: string | null;
  expires_at: string;
  accepted_at: string | null;
  accepted_by_user_id: string | null;
  accounts: { name: string } | null;
}

function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

function fail(reason: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, reason, ...extra }, { status });
}

async function loadInvite(token: string): Promise<InviteRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("account_invitations")
    .select(
      "id, role, email, label, expires_at, accepted_at, accepted_by_user_id, accounts(name)",
    )
    .eq("token_hash", hashInviteToken(token))
    .maybeSingle();
  if (error) throw error;
  return data as InviteRow | null;
}

function isAlreadyRegistered(error: { message?: string; status?: number; code?: string }) {
  return (
    error.code === "email_exists" ||
    error.status === 422 ||
    /already (been )?registered|already exists/i.test(error.message ?? "")
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const limit = checkRateLimit(`peek:${getClientIp(request)}`, RATE_LIMITS.invitationPeek);
  if (!limit.success) return rateLimitResponse(limit);

  const { token } = await params;
  try {
    const inv = token ? await loadInvite(token) : null;
    if (!inv) return fail("not_found", 404);
    if (inv.accepted_at) return fail("used", 400);
    if (new Date(inv.expires_at) <= new Date()) return fail("expired", 400);
    return NextResponse.json({
      ok: true,
      account_name: inv.accounts?.name ?? "tu equipo",
      role: inv.role,
      expires_at: inv.expires_at,
      email: inv.email,
      name: inv.label,
    });
  } catch (err) {
    console.error("[enter] peek error:", err);
    return fail("server_error", 500);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const limit = checkRateLimit(`redeem:${getClientIp(request)}`, RATE_LIMITS.invitationRedeem);
  if (!limit.success) return rateLimitResponse(limit);

  const { token } = await params;
  const body = (await request.json().catch(() => null)) as {
    mode?: unknown;
    email?: unknown;
    password?: unknown;
    full_name?: unknown;
  } | null;

  const mode = body?.mode === "login" ? "login" : "create";
  const password = typeof body?.password === "string" ? body.password : "";
  const fullName =
    typeof body?.full_name === "string"
      ? body.full_name.trim().slice(0, MAX_NAME_LEN)
      : "";

  let inv: InviteRow | null;
  try {
    inv = token ? await loadInvite(token) : null;
  } catch (err) {
    console.error("[enter] invite lookup error:", err);
    return fail("server_error", 500);
  }
  if (!inv) return fail("not_found", 404);
  if (new Date(inv.expires_at) <= new Date() && !inv.accepted_at) {
    return fail("expired", 400);
  }

  // An email invite fixes the address; a link typed-in one is checked here.
  const email = (inv.email ?? (typeof body?.email === "string" ? body.email : ""))
    .trim()
    .toLowerCase();
  if (!EMAIL_RE.test(email)) return fail("invalid_email", 400);
  if (!password) return fail("missing_password", 400);

  // A used link only lets its own user back in (a second tap, a redirect
  // that didn't finish). Nobody else gets an account out of it.
  if (inv.accepted_at && mode === "create") return fail("used", 400);

  const admin = supabaseAdmin();
  let emailTaken = false;

  if (mode === "create") {
    if (password.length < MIN_PASSWORD) return fail("weak_password", 400);
    if (!fullName) return fail("missing_name", 400);

    const { error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });

    if (error) {
      if (error.code === "weak_password") return fail("weak_password", 400);
      if (!isAlreadyRegistered(error)) {
        console.error("[enter] createUser failed:", error.message);
        return fail("server_error", 500);
      }
      emailTaken = true;

      // The invitee Supabase created when this email invite went out, who
      // never signed in: no password exists yet, and holding this link
      // is holding that inbox's message.
      const { data: profile } = await admin
        .from("profiles")
        .select("user_id")
        .eq("email", email)
        .maybeSingle();
      if (profile?.user_id && inv.email === email) {
        const { data: found } = await admin.auth.admin.getUserById(profile.user_id);
        const user = found?.user;
        if (user && user.invited_at && !user.last_sign_in_at) {
          const { error: updError } = await admin.auth.admin.updateUserById(user.id, {
            password,
            email_confirm: true,
            user_metadata: { ...user.user_metadata, full_name: fullName },
          });
          if (updError) {
            if (updError.code === "weak_password") return fail("weak_password", 400);
            console.error("[enter] could not set the invitee's password:", updError.message);
            return fail("server_error", 500);
          }
          await admin.from("profiles").update({ full_name: fullName }).eq("user_id", user.id);
          emailTaken = false;
        }
      }
    }
  }

  // A fresh, in-memory client: this session belongs to the Golden App.
  const client = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  );
  const { data: signIn, error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError || !signIn.session) {
    return fail(emailTaken ? "existing_account" : "wrong_password", 401, { email });
  }
  const session = signIn.session;

  if (inv.accepted_at) {
    if (inv.accepted_by_user_id !== session.user.id) return fail("used", 400);
  } else {
    const { error: redeemError } = await client.rpc("redeem_invitation", {
      p_token_hash: hashInviteToken(token),
    });
    // Already on this team (an owner trying their own link): nothing to
    // join, and the password was right, so just let them in.
    const alreadyHere =
      redeemError?.code === "23505" && /already a member/i.test(redeemError.message);
    if (redeemError && !alreadyHere) {
      await client.auth.signOut().catch(() => {});
      if (redeemError.code === "23505") return fail("other_account", 409);
      if (redeemError.code === "22023") {
        return fail(/expired/i.test(redeemError.message) ? "expired" : "used", 400);
      }
      console.error("[enter] redeem failed:", redeemError);
      return fail("server_error", 500);
    }
  }

  return NextResponse.json({
    ok: true,
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    golden_app_url: process.env.NEXT_PUBLIC_GOLDEN_APP_URL?.replace(/\/+$/, "") || null,
  });
}
