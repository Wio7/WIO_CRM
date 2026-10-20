import { NextResponse } from "next/server";
import { requireSuperAdmin, toErrorResponse } from "@/lib/auth/account";
import { createClient } from "@supabase/supabase-js";
import {
  clampExpiryDays,
  generateInviteToken,
  getBaseUrl,
  inviteExpiresAt,
  inviteUrl,
} from "@/lib/auth/invitations";
import { isAccountRole } from "@/lib/auth/roles";

const MAX_LABEL_LEN = 80;

/**
 * POST /api/admin/accounts/[accountId]/invitations  (super admin only)
 *
 * The SaaS-owner equivalent of /api/account/invitations — same
 * token/link mechanics (see src/lib/auth/invitations.ts), but for
 * an arbitrary account chosen from the /saas-owner panel rather
 * than the caller's own account. requireSuperAdmin verifica platform_admins.
 * El rol owner/admin de una cuenta no concede este permiso.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const { accountId } = await params;

    const { userId } = await requireSuperAdmin();

    const body = (await req.json().catch(() => null)) as
      | { role?: unknown; expiresInDays?: unknown; label?: unknown }
      | null;

    const role = body?.role;
    if (!isAccountRole(role) || role === "owner") {
      return NextResponse.json(
        { error: "'role' must be one of admin, agent, viewer" },
        { status: 400 },
      );
    }

    let label: string | null = null;
    if (typeof body?.label === "string") {
      const trimmed = body.label.trim();
      if (trimmed.length > MAX_LABEL_LEN) {
        return NextResponse.json(
          { error: `Label must be ${MAX_LABEL_LEN} characters or fewer` },
          { status: 400 },
        );
      }
      label = trimmed === "" ? null : trimmed;
    }

    const expiresInDaysRaw = body?.expiresInDays;
    const expiresInDays =
      typeof expiresInDaysRaw === "number" ? expiresInDaysRaw : undefined;
    const expiryDays = clampExpiryDays(expiresInDays);
    const expiresAt = inviteExpiresAt(expiryDays);

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const { data: account, error: accountErr } = await supabaseAdmin
      .from("accounts")
      .select("id")
      .eq("id", accountId)
      .maybeSingle();
    if (accountErr || !account) {
      return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });
    }

    const { token, hash } = generateInviteToken();

    const { data, error } = await supabaseAdmin
      .from("account_invitations")
      .insert({
        account_id: accountId,
        token_hash: hash,
        role,
        created_by_user_id: userId,
        label,
        expires_at: expiresAt.toISOString(),
      })
      .select("id, role, label, expires_at, created_at")
      .single();

    if (error || !data) {
      console.error("[admin/accounts/[id]/invitations POST] insert error:", error);
      return NextResponse.json(
        { error: "Failed to create invitation" },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        invitation: data,
        token,
        url: inviteUrl(token, getBaseUrl(req)),
        expiresInDays: expiryDays,
      },
      { status: 201 },
    );
  } catch (error: unknown) {
    console.error("[admin/accounts/[id]/invitations POST] Exception:", error);
    return toErrorResponse(error);
  }
}
