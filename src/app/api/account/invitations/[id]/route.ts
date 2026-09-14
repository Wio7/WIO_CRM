// ============================================================
// DELETE /api/account/invitations/[id]
//
// Admin+. Revokes a pending invitation by id. RLS on
// `account_invitations` already restricts the DELETE to admins
// of the inviting account; we lean on it and skip the explicit
// ownership check.
//
// We intentionally delete the row outright rather than soft-
// deleting (a "revoked_at" flag). Once revoked, an invite is
// dead forever — there's no UX where a former invite should be
// listed; the plaintext token is gone too. Hard delete keeps
// the table small.
//
// CORS-wrapped for the Golden App's Team screen (Bearer token).
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { corsPreflight, withCors } from "@/lib/cors";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: RouteContext) {
  return withCors(request, await revokeInvitation(context));
}

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

async function revokeInvitation({ params }: RouteContext): Promise<Response> {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:inviteRevoke:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    // No `eq('account_id', ctx.accountId)` — the RLS policy
    // (`is_account_member(account_id, 'admin')`) already scopes
    // the DELETE to invites in the caller's account. Omitting the
    // filter surfaces a cross-account attempt as a silent 0-row
    // delete (which is exactly what we want for revocation).
    const { error, count } = await ctx.supabase
      .from("account_invitations")
      .delete({ count: "exact" })
      .eq("id", id);

    if (error) {
      console.error("[DELETE /api/account/invitations/[id]] error:", error);
      return NextResponse.json(
        { error: "Failed to revoke invitation" },
        { status: 500 },
      );
    }

    if (count === 0) {
      // Either the id doesn't exist or RLS hid it (different
      // account). 404 either way — surfacing "exists but not
      // yours" would leak existence.
      return NextResponse.json(
        { error: "Invitation not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
