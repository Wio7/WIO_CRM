// ============================================================
// Client portal sessions — the database side of phone + DNI sign-in.
//
// Always called with the service-role client: `client_sessions` and
// `client_login_attempts` have RLS on and no policies (migration 045).
// Every read a client makes later goes through `resolveClientSession`,
// which yields ONE contact id; routes filter by it and nothing else.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { notifyConversation } from "@/lib/push/send";
import {
  IP_WINDOW_MS,
  MAX_FAILS_PER_PHONE,
  PHONE_WINDOW_MS,
  SESSION_TTL_MS,
  failsSinceSuccess,
  firstName,
  hashSessionToken,
  ipLockedUntil,
  maskPhone,
  newSessionToken,
  normalizeDni,
  phoneCandidates,
  phoneKey,
  phoneLockedUntil,
  sameSecret,
} from "./identity";

export type SignInResult =
  | {
      ok: true;
      token: string;
      expires_at: string;
      client: ClientSummary;
    }
  | { ok: false; reason: "invalid_input" | "no_match" | "server_error" }
  | { ok: false; reason: "locked"; retry_after_seconds: number };

export interface ClientSummary {
  name: string;
  first_name: string;
  phone_hint: string;
  account_name: string;
  /**
   * Qué le toca ver al entrar:
   *   comprador  ya paga su lote o su casa: cuotas, saldo y vouchers.
   *   visitante  todavía no compró: proyectos, beneficios y su asesor.
   * Lo decide el plan de pagos (043), no una casilla que alguien olvide.
   */
  tipo: "comprador" | "visitante";
}

interface ContactRow {
  id: string;
  account_id: string;
  name: string | null;
  phone: string;
  dni: string | null;
  accounts: { name: string; client_portal_enabled: boolean } | null;
}

const since = (ms: number) => new Date(Date.now() - ms).toISOString();

export async function signInClient(
  db: SupabaseClient,
  input: { phone: string; dni: string; ip: string; userAgent: string | null },
): Promise<SignInResult> {
  const candidates = phoneCandidates(input.phone);
  const dni = normalizeDni(input.dni);
  if (!candidates.length || !dni) return { ok: false, reason: "invalid_input" };
  const key = phoneKey(input.phone);

  // 1. Locks first, before touching contacts: a locked guesser learns
  //    nothing, not even whether the number is a client.
  const [byPhone, byIp] = await Promise.all([
    db
      .from("client_login_attempts")
      .select("succeeded, created_at")
      .eq("phone_digits", key)
      .gte("created_at", since(PHONE_WINDOW_MS))
      .order("created_at", { ascending: false })
      .limit(50),
    db
      .from("client_login_attempts")
      .select("succeeded, created_at")
      .eq("ip", input.ip)
      .gte("created_at", since(IP_WINDOW_MS))
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  if (byPhone.error || byIp.error) {
    console.error("[client-portal] attempts lookup failed:", byPhone.error ?? byIp.error);
    return { ok: false, reason: "server_error" };
  }
  const lockedUntil = Math.max(
    phoneLockedUntil(byPhone.data ?? []) ?? 0,
    ipLockedUntil(byIp.data ?? []) ?? 0,
  );
  if (lockedUntil > Date.now()) {
    return {
      ok: false,
      reason: "locked",
      retry_after_seconds: Math.ceil((lockedUntil - Date.now()) / 1000),
    };
  }

  // 2. The contact: this phone, in an account with the portal open.
  const { data: rows, error } = await db
    .from("contacts")
    .select("id, account_id, name, phone, dni, accounts!inner(name, client_portal_enabled)")
    .in("phone_normalized", candidates)
    .eq("accounts.client_portal_enabled", true)
    .not("dni", "is", null)
    .limit(10);
  if (error) {
    console.error("[client-portal] contact lookup failed:", error);
    return { ok: false, reason: "server_error" };
  }

  const contacts = (rows ?? []) as unknown as ContactRow[];
  const match = contacts.find((c) => c.dni && sameSecret(c.dni, dni));

  await db.from("client_login_attempts").insert({
    phone_digits: key,
    ip: input.ip,
    succeeded: Boolean(match),
    contact_id: match?.id ?? contacts[0]?.id ?? null,
  });

  if (!match) {
    // The try that locks a real client's number is worth an advisor's
    // attention: either the client is stuck, or someone is guessing.
    const failsBefore = failsSinceSuccess(byPhone.data ?? []).length;
    if (contacts[0] && failsBefore + 1 === MAX_FAILS_PER_PHONE) {
      await warnAdvisor(db, contacts[0]).catch((err) =>
        console.error("[client-portal] could not warn the advisor:", err),
      );
    }
    return { ok: false, reason: "no_match" };
  }

  // 3. The session.
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const { error: insertError } = await db.from("client_sessions").insert({
    account_id: match.account_id,
    contact_id: match.id,
    token_hash: hashSessionToken(token),
    user_agent: input.userAgent?.slice(0, 300) ?? null,
    expires_at: expiresAt,
  });
  if (insertError) {
    console.error("[client-portal] session insert failed:", insertError);
    return { ok: false, reason: "server_error" };
  }

  return {
    ok: true,
    token,
    expires_at: expiresAt,
    client: await resumenConTipo(db, match),
  };
}

export interface ClientSession {
  sessionId: string;
  accountId: string;
  contactId: string;
  expiresAt: string;
  client: ClientSummary;
}

/**
 * The session behind a Bearer token, or null if it doesn't exist, was
 * revoked or expired. Extends the session while the client keeps coming
 * back (at most once an hour, to keep writes down).
 */
export async function resolveClientSession(
  db: SupabaseClient,
  token: string,
): Promise<ClientSession | null> {
  if (!token || token.length < 32 || token.length > 128) return null;

  const { data, error } = await db
    .from("client_sessions")
    .select(
      "id, account_id, contact_id, expires_at, revoked_at, last_seen_at, contacts(id, account_id, name, phone, dni, accounts(name, client_portal_enabled))",
    )
    .eq("token_hash", hashSessionToken(token))
    .maybeSingle();
  if (error || !data) return null;

  const contact = data.contacts as unknown as ContactRow | null;
  if (
    data.revoked_at ||
    Date.parse(data.expires_at) <= Date.now() ||
    !contact?.dni ||
    !contact.accounts?.client_portal_enabled
  ) {
    return null;
  }

  let expiresAt = data.expires_at as string;
  if (Date.now() - Date.parse(data.last_seen_at) > 60 * 60_000) {
    expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await db
      .from("client_sessions")
      .update({ last_seen_at: new Date().toISOString(), expires_at: expiresAt })
      .eq("id", data.id);
  }

  return {
    sessionId: data.id,
    accountId: data.account_id,
    contactId: data.contact_id,
    expiresAt,
    client: await resumenConTipo(db, contact),
  };
}

export async function revokeClientSession(db: SupabaseClient, token: string): Promise<void> {
  if (!token) return;
  await db
    .from("client_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", hashSessionToken(token))
    .is("revoked_at", null);
}

function summary(contact: ContactRow, tipo: ClientSummary["tipo"]): ClientSummary {
  return {
    name: contact.name?.trim() || "",
    first_name: firstName(contact.name),
    phone_hint: maskPhone(contact.phone),
    account_name: contact.accounts?.name ?? "",
    tipo,
  };
}

/**
 * Comprador si tiene un plan de pagos vivo; visitante si no. Un fallo al
 * preguntarlo deja "visitante": es la vista que no promete nada.
 */
async function resumenConTipo(db: SupabaseClient, contact: ContactRow): Promise<ClientSummary> {
  const { count, error } = await db
    .from("payment_plans")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contact.id)
    .in("status", ["activo", "pagado"]);
  if (error) console.error("[client-portal] payment plan lookup failed:", error);
  return summary(contact, count && count > 0 ? "comprador" : "visitante");
}

/** Push to whoever owns the client's latest conversation (or the admins). */
async function warnAdvisor(db: SupabaseClient, contact: ContactRow) {
  const { data: conv } = await db
    .from("conversations")
    .select("id, assigned_agent_id")
    .eq("contact_id", contact.id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conv) return;

  await notifyConversation(db, {
    accountId: contact.account_id,
    conversationId: conv.id,
    assignedAgentId: conv.assigned_agent_id ?? null,
    title: "Acceso de cliente bloqueado",
    body: `${contact.name || contact.phone} no pudo entrar a la app: ${MAX_FAILS_PER_PHONE} intentos con un DNI que no coincide. Si es el cliente, revisa el DNI de su ficha.`,
  });
}
