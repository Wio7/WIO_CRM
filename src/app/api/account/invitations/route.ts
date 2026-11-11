// ============================================================
// /api/account/invitations
//
//   GET  — list outstanding (un-redeemed, non-expired) invites. With
//          ?todas=1 also the accepted and expired ones of the last 60 days,
//          each with an `estado` (pendiente | aceptada | vencida).
//   POST — create an invite and, when an email is given, send it.
//
// A body may carry `area: 'promueve'` (only with role 'agent', migration
// 091): the external Promueve advisors join through the very same link as
// the team and land with the restricted view.
//
// Both admin+. Only owners may invite with role 'owner' (migration 040
// enforces the same rule in the database). The Members tab and the
// Golden App's Team screen call these; the Golden App authenticates
// with a Bearer access token, hence the CORS wrappers.
//
// IMPORTANT: the plaintext token is returned exactly ONCE — in
// the POST response. We store only the SHA-256 hash on the row,
// so neither GET nor a future PATCH can ever resurface the
// link. When the email doesn't arrive, the inviter can still share
// that one-time link by hand.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { sendInviteEmail } from "@/lib/auth/invite-email";
import {
  clampExpiryDays,
  generateInviteToken,
  getBaseUrl,
  inviteExpiresAt,
  inviteUrl,
} from "@/lib/auth/invitations";
import { isAccountRole } from "@/lib/auth/roles";
import { corsPreflight, withCors } from "@/lib/cors";
import { areaDeInvitacion, estadoInvitacion } from "@/lib/promueve/invitacion";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

const MAX_LABEL_LEN = 80;
const MAX_NAME_LEN = 80;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(request: Request) {
  const todas = new URL(request.url).searchParams.get("todas") === "1";
  return withCors(request, await listInvitations(todas));
}

export async function POST(request: Request) {
  return withCors(request, await createInvitation(request));
}

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

const LIST_COLUMNS =
  "id, role, email, label, created_by_user_id, created_at, expires_at, accepted_at, accepted_by_user_id";
const DIAS_HISTORIAL = 60;

async function listInvitations(todas = false): Promise<Response> {
  try {
    const ctx = await requireRole("admin");

    const consulta = (columnas: string) => {
      let q = ctx.supabase
        .from("account_invitations")
        .select(columnas)
        .eq("account_id", ctx.accountId)
        .order("created_at", { ascending: false });
      if (todas) {
        const desde = new Date(Date.now() - DIAS_HISTORIAL * 86_400_000);
        q = q.gt("created_at", desde.toISOString()).limit(100);
      } else {
        q = q.is("accepted_at", null).gt("expires_at", new Date().toISOString());
      }
      return q;
    };

    // Con la migración 091 la lista trae el área. Mientras no esté aplicada
    // (42703: la columna no existe) se sirve igual, sin ella.
    let { data, error } = await consulta(`${LIST_COLUMNS}, area`);
    if (error?.code === "42703") ({ data, error } = await consulta(LIST_COLUMNS));

    if (error) {
      console.error("[GET /api/account/invitations] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to load invitations" },
        { status: 500 },
      );
    }

    const filas = (data ?? []) as unknown as Array<{
      accepted_at: string | null;
      expires_at: string;
    }>;
    return NextResponse.json({
      invitations: todas
        ? filas.map((f) => ({ ...f, estado: estadoInvitacion(f) }))
        : filas,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function createInvitation(request: Request): Promise<Response> {
  try {
    const ctx = await requireRole("admin");

    // 30/min per user. The Members tab is a clicks-only UI so any
    // legitimate admin is far below this; the cap exists to keep
    // a script run in a loop or a compromised admin session from
    // flooding `account_invitations` with rows (and inboxes).
    const limit = checkRateLimit(
      `admin:inviteCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | {
          role?: unknown;
          expiresInDays?: unknown;
          label?: unknown;
          email?: unknown;
          full_name?: unknown;
          area?: unknown;
        }
      | null;

    const role = body?.role;
    if (!isAccountRole(role)) {
      return NextResponse.json(
        { error: "'role' must be one of owner, admin, agent, viewer" },
        { status: 400 },
      );
    }
    // Misma jerarquía que set_member_role (057): un administrador reparte
    // asesores y solo-lectura; hacer administradores o dueños es del dueño.
    // Si no, un admin invita a un admin y se salta la regla por la puerta
    // de al lado.
    if ((role === "owner" || role === "admin") && ctx.role !== "owner") {
      return NextResponse.json(
        {
          error:
            role === "owner"
              ? "Only an owner can invite another owner"
              : "Only an owner can invite an admin",
        },
        { status: 403 },
      );
    }

    // Promueve (migración 091): solo con rol 'agent'. Un administrador puede
    // invitar agentes, así que también puede invitar Promueve. El área solo
    // la recibe quien canjea el enlace siendo un invitado nuevo; la RPC
    // redeem_invitation rechaza a quien ya es miembro o tiene datos.
    const areaCheck = areaDeInvitacion(body?.area, role);
    if (!areaCheck.ok) {
      return NextResponse.json({ error: areaCheck.error }, { status: 400 });
    }
    const area = areaCheck.area;

    const expiresInDaysRaw = body?.expiresInDays;
    // `clampExpiryDays` tolerates undefined / NaN / negatives by
    // collapsing to the safe default, so we just pass the raw
    // value through after a type narrow.
    const expiresInDays =
      typeof expiresInDaysRaw === "number" ? expiresInDaysRaw : undefined;
    const expiryDays = clampExpiryDays(expiresInDays);
    const expiresAt = inviteExpiresAt(expiryDays);

    let email: string | null = null;
    if (typeof body?.email === "string" && body.email.trim() !== "") {
      const candidate = body.email.trim().toLowerCase();
      if (!EMAIL_RE.test(candidate)) {
        return NextResponse.json(
          { error: "'email' is not a valid address" },
          { status: 400 },
        );
      }
      email = candidate;
    }

    let fullName: string | null = null;
    if (typeof body?.full_name === "string") {
      const trimmed = body.full_name.trim().slice(0, MAX_NAME_LEN);
      fullName = trimmed === "" ? null : trimmed;
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
    // The name is the most useful label in the pending list.
    label = label ?? fullName;

    const { token, hash } = generateInviteToken();

    const { data, error } = await ctx.supabase
      .from("account_invitations")
      .insert({
        account_id: ctx.accountId,
        token_hash: hash,
        role,
        email,
        created_by_user_id: ctx.userId,
        label,
        expires_at: expiresAt.toISOString(),
        // Sin área no se manda la columna: así la creación sigue andando
        // aunque la 091 todavía no esté aplicada.
        ...(area ? { area } : {}),
      })
      .select(
        area
          ? "id, role, area, email, label, expires_at, created_at"
          : "id, role, email, label, expires_at, created_at",
      )
      .single();

    if (error || !data) {
      console.error("[POST /api/account/invitations] insert error:", error);
      if (error?.code === "42501") {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      return NextResponse.json(
        { error: "Failed to create invitation" },
        { status: 500 },
      );
    }

    const url = inviteUrl(token, getBaseUrl(request));
    const delivery = email ? await sendInviteEmail(email, url, fullName) : null;

    return NextResponse.json(
      {
        invitation: data,
        // Plaintext payload — visible to the admin exactly once.
        token,
        url,
        expiresInDays: expiryDays,
        email_sent: delivery?.sent ?? false,
        email_kind: delivery?.sent ? delivery.kind : null,
        email_error: delivery && !delivery.sent ? delivery.error : null,
      },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
