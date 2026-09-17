// ============================================================
// /api/account/members/[userId]
//
//   PATCH  — change a member's role and/or area.   Admin+.
//   DELETE — remove a member.          Admin+.
//
// Both delegate to SECURITY DEFINER RPCs (018, rewritten in 040):
//   - set_member_role(p_user_id, p_new_role)
//   - set_member_area(p_user_id, p_area)      (046)
//   - remove_account_member(p_user_id)
//
// The RPCs do the *real* authorisation work — caller must be admin+,
// target must be in caller's account, can't be self, can't be the
// primary owner, and only an owner can grant/remove the owner role.
// The TS layer forwards the call and maps SQLSTATEs to HTTP statuses.
// CORS-wrapped for the Golden App's Team screen (Bearer token).
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { isAccountRole } from "@/lib/auth/roles";
import { MEMBER_AREAS, type MemberArea } from "@/types";
import { corsPreflight, withCors } from "@/lib/cors";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

type RouteContext = { params: Promise<{ userId: string }> };

// Map known SQLSTATEs from the RPCs onto HTTP statuses. The
// `error.code` field is the SQLSTATE; the `message` is the
// human-readable RAISE message from the migration.
function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === "42501") {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === "22023") {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error("[members route] unexpected RPC error:", err);
  return NextResponse.json(
    { error: "Failed to update member" },
    { status: 500 },
  );
}

export async function PATCH(request: Request, context: RouteContext) {
  return withCors(request, await changeMember(request, context));
}

export async function DELETE(request: Request, context: RouteContext) {
  return withCors(request, await removeMember(context));
}

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

/** True for a valid area, and also for null: "no area" is a valid answer. */
function isArea(value: unknown): value is MemberArea | null {
  return value === null || MEMBER_AREAS.includes(value as MemberArea);
}

async function changeMember(
  request: Request,
  { params }: RouteContext,
): Promise<Response> {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberRole:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const body = (await request.json().catch(() => null)) as
      | { role?: unknown; area?: unknown }
      | null;

    // Either field on its own is a valid call: the Team screen changes the
    // role and the area with separate controls.
    const cambiaRol = body ? "role" in body : false;
    const cambiaArea = body ? "area" in body : false;
    if (!cambiaRol && !cambiaArea) {
      return NextResponse.json(
        { error: "Send 'role', 'area' or both" },
        { status: 400 },
      );
    }
    if (cambiaRol && !isAccountRole(body?.role)) {
      return NextResponse.json(
        { error: "'role' must be one of owner, admin, agent, viewer" },
        { status: 400 },
      );
    }
    if (cambiaArea && !isArea(body?.area)) {
      return NextResponse.json(
        { error: "'area' must be marketing, legal, cobranzas, ventas or null" },
        { status: 400 },
      );
    }

    if (cambiaRol) {
      const { error } = await ctx.supabase.rpc("set_member_role", {
        p_user_id: userId,
        p_new_role: body?.role as string,
      });
      if (error) return rpcErrorToResponse(error);
    }

    if (cambiaArea) {
      const { error } = await ctx.supabase.rpc("set_member_area", {
        p_user_id: userId,
        p_area: (body?.area ?? null) as string | null,
      });
      if (error) return rpcErrorToResponse(error);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function removeMember({ params }: RouteContext): Promise<Response> {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:memberRemove:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const { data, error } = await ctx.supabase.rpc("remove_account_member", {
      p_user_id: userId,
    });

    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ ok: true, newPersonalAccountId: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
