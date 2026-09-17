// ============================================================
// GET /api/account/members
//
// Lists every member of the caller's account. Any member can call
// it (the Members tab is shown to admins+, but agents/viewers see
// a read-only roster too).
//
// Field visibility
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only.
//
// `is_primary_owner` marks accounts.owner_user_id — with several
// owners allowed (migration 040), that one can't be edited or removed.
// CORS-wrapped for the Golden App's Team screen (Bearer token).
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { canManageMembers, isAccountRole } from "@/lib/auth/roles";
import { corsPreflight, withCors } from "@/lib/cors";
import { MEMBER_AREAS, type AccountMember, type MemberArea } from "@/types";

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  account_role: string;
  /** What this member does: marketing, legal, cobranzas, ventas (046). */
  area: string | null;
  created_at: string;
}

export async function GET(request: Request) {
  return withCors(request, await listMembers());
}

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

async function listMembers(): Promise<Response> {
  try {
    const ctx = await getCurrentAccount();

    // RLS on profiles allows reading any row whose account matches
    // the caller's, so this query is naturally account-scoped.
    // `area` llega con la migración 046. Mientras no esté aplicada, pedirla
    // haría fallar la lista entera y el equipo desaparecería de la app; por
    // eso se vuelve a pedir sin ella.
    const COLUMNAS = "user_id, full_name, email, avatar_url, account_role, created_at";
    const pedirMiembros = (columnas: string) =>
      ctx.supabase
        .from("profiles")
        .select(columnas)
        .eq("account_id", ctx.accountId)
        .order("created_at", { ascending: true });

    const [primera, { data: account }] = await Promise.all([
      pedirMiembros(`${COLUMNAS}, area`),
      ctx.supabase
        .from("accounts")
        .select("owner_user_id")
        .eq("id", ctx.accountId)
        .maybeSingle(),
    ]);

    let { data, error } = primera as { data: unknown; error: { code?: string; message?: string } | null };
    if (error && (error.code === "42703" || /area/i.test(error.message ?? ""))) {
      ({ data, error } = (await pedirMiembros(COLUMNAS)) as typeof primera);
    }

    if (error) {
      console.error("[GET /api/account/members] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }

    const canSeeEmails = canManageMembers(ctx.role);
    const primaryOwner = (account?.owner_user_id as string | undefined) ?? null;

    const members: AccountMember[] = (data as ProfileRow[]).flatMap((row) => {
      // Defensive: the DB enum should never let an unknown role
      // through, but if a migration ever broadens the enum without
      // updating TS, skip the row rather than crash the page.
      if (!isAccountRole(row.account_role)) return [];
      return [
        {
          user_id: row.user_id,
          full_name: row.full_name ?? "",
          email: canSeeEmails ? row.email : null,
          avatar_url: row.avatar_url,
          role: row.account_role,
          // Igual que con el rol: un valor que no conocemos se ignora en vez
          // de romper la pantalla.
          area: MEMBER_AREAS.includes(row.area as MemberArea) ? (row.area as MemberArea) : null,
          joined_at: row.created_at,
          is_primary_owner: row.user_id === primaryOwner,
        },
      ];
    });

    return NextResponse.json({
      members,
      my_role: ctx.role,
      my_user_id: ctx.userId,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
