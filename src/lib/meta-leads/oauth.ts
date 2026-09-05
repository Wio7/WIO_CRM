// ============================================================
// Meta Login for Business — OAuth authorization-code flow.
//
// Backs the "Conectar con Facebook" button. The admin authenticates on
// Meta's own domain (we never see the password); Meta hands back a code,
// we exchange it for a long-lived user token, and from that we derive
// non-expiring Page tokens.
//
// Token chain, and why the order matters:
//
//   code → short-lived user token (~1h)
//        → long-lived user token (~60d)      [exchangeForLongLivedToken]
//        → Page tokens                        [listPages]
//
// Page tokens inherit their lifetime from the user token they were
// minted from, so calling /me/accounts with the LONG-lived token yields
// Page tokens that never expire. Calling it with the short-lived one
// would yield 1-hour Page tokens and force us to build refresh
// machinery. Always exchange first.
// ============================================================

import crypto from 'node:crypto';

const META_API_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${META_API_VERSION}`;
const DIALOG_BASE = `https://www.facebook.com/${META_API_VERSION}/dialog/oauth`;

/**
 * Permissions requested on the consent screen.
 *
 *   pages_show_list        — enumerate the Pages the user manages
 *   pages_read_engagement  — read Page metadata (name, etc.)
 *   pages_manage_metadata  — subscribe the Page to our app's leadgen webhook
 *   leads_retrieval        — read the actual lead answers
 *
 * While the app is in Development mode these work without App Review for
 * anyone holding a role on the app (admin/developer/tester). Going Live
 * for third-party clients requires App Review of `leads_retrieval` and
 * `pages_manage_metadata` — no code change, just app status.
 */
export const META_OAUTH_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
  'leads_retrieval',
] as const;

/** State payload lifetime. Long enough to log in, short enough to matter. */
const STATE_TTL_MS = 10 * 60 * 1000;

function appId(): string {
  const id = process.env.META_APP_ID;
  if (!id) throw new Error('META_APP_ID is not configured');
  return id;
}

function appSecret(): string {
  const secret = process.env.META_APP_SECRET;
  if (!secret) throw new Error('META_APP_SECRET is not configured');
  return secret;
}

/**
 * Key for signing the `state` parameter. Reuses ENCRYPTION_KEY (already
 * required for every Meta secret at rest) rather than introducing another
 * env var an operator could forget to set.
 */
function stateKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY is not configured');
  return Buffer.from(key, 'hex');
}

// ------------------------------------------------------------
// State: CSRF protection + carrying the target account
// ------------------------------------------------------------

/**
 * Build a signed `state` value.
 *
 * Two jobs: prove the callback we receive is the continuation of a flow
 * WE started (CSRF), and carry which account is connecting — the callback
 * runs in a top-level browser redirect where we can still read the
 * session, but binding the account into signed state means a user who
 * somehow lands on another account's callback can't have tokens written
 * to the wrong tenant.
 *
 * Format: base64url(payload).hex(hmac) — payload is `accountId:nonce:issuedAt`.
 */
export function signState(accountId: string): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${accountId}:${nonce}:${Date.now()}`;
  const encoded = Buffer.from(payload).toString('base64url');
  const mac = crypto
    .createHmac('sha256', stateKey())
    .update(encoded)
    .digest('hex');
  return `${encoded}.${mac}`;
}

/**
 * Verify a `state` round-tripped through Meta. Returns the account id, or
 * null when the signature is wrong, the format is off, or it has expired.
 * Constant-time comparison so a forged state can't be brute-forced by
 * timing the response.
 */
export function verifyState(state: string | null): string | null {
  if (!state) return null;
  const [encoded, mac] = state.split('.');
  if (!encoded || !mac) return null;

  const expected = crypto
    .createHmac('sha256', stateKey())
    .update(encoded)
    .digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString();
  } catch {
    return null;
  }
  const [accountId, , issuedAtRaw] = payload.split(':');
  const issuedAt = Number(issuedAtRaw);
  if (!accountId || !Number.isFinite(issuedAt)) return null;
  if (Date.now() - issuedAt > STATE_TTL_MS) return null;
  return accountId;
}

// ------------------------------------------------------------
// The flow
// ------------------------------------------------------------

/** The consent-screen URL to redirect the admin to. */
export function buildAuthorizeUrl(
  accountId: string,
  redirectUri: string,
): string {
  const params = new URLSearchParams({
    client_id: appId(),
    redirect_uri: redirectUri,
    state: signState(accountId),
    scope: META_OAUTH_SCOPES.join(','),
    response_type: 'code',
  });
  return `${DIALOG_BASE}?${params.toString()}`;
}

/** Shared Graph GET that turns Meta's error envelope into a real throw. */
async function graphGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${GRAPH_BASE}/${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url);
  const json = (await res.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null;
  if (!res.ok || !json || json.error) {
    throw new Error(json?.error?.message ?? `Graph API error: ${res.status}`);
  }
  return json;
}

export interface TokenResponse {
  access_token: string;
  /** Seconds until expiry. Absent for tokens Meta considers non-expiring. */
  expires_in?: number;
}

/** Exchange the authorization code for a short-lived user token. */
export async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  return graphGet<TokenResponse>('oauth/access_token', {
    client_id: appId(),
    client_secret: appSecret(),
    redirect_uri: redirectUri,
    code,
  });
}

/** Upgrade a short-lived user token to a ~60-day one. */
export async function exchangeForLongLivedToken(
  shortLivedToken: string,
): Promise<TokenResponse> {
  return graphGet<TokenResponse>('oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId(),
    client_secret: appSecret(),
    fb_exchange_token: shortLivedToken,
  });
}

export interface MetaUser {
  id: string;
  name?: string;
}

/** Who authorized us — shown as "Conectado como {name}". */
export async function fetchMe(userToken: string): Promise<MetaUser> {
  return graphGet<MetaUser>('me', { fields: 'id,name', access_token: userToken });
}

export interface MetaPageSummary {
  id: string;
  name: string;
  /** Page token, inheriting the user token's lifetime. */
  access_token: string;
}

/**
 * List the Pages this user manages. Pass the LONG-lived user token (see
 * the token-chain note at the top of this file).
 */
export async function listPages(userToken: string): Promise<MetaPageSummary[]> {
  const data = await graphGet<{ data?: MetaPageSummary[] }>('me/accounts', {
    fields: 'id,name,access_token',
    limit: '100',
    access_token: userToken,
  });
  return data.data ?? [];
}

/**
 * Subscribe a Page to our app's `leadgen` webhook field. Until this runs,
 * Meta delivers nothing for the page no matter what the app-level
 * subscription says.
 */
export async function subscribePageToApp(
  pageId: string,
  pageAccessToken: string,
): Promise<void> {
  const url = `${GRAPH_BASE}/${pageId}/subscribed_apps`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      subscribed_fields: 'leadgen',
      access_token: pageAccessToken,
    }),
  });
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    error?: { message?: string };
  } | null;
  if (!res.ok || json?.error) {
    throw new Error(json?.error?.message ?? `Failed to subscribe page: ${res.status}`);
  }
}

/** Undo `subscribePageToApp`. Best-effort — used on toggle-off and disconnect. */
export async function unsubscribePageFromApp(
  pageId: string,
  pageAccessToken: string,
): Promise<void> {
  const url = `${GRAPH_BASE}/${pageId}/subscribed_apps?access_token=${encodeURIComponent(
    pageAccessToken,
  )}`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(json?.error?.message ?? `Failed to unsubscribe page: ${res.status}`);
  }
}

export interface MetaLeadForm {
  id: string;
  name?: string;
  status?: string;
}

/**
 * The lead forms living on a Page. Informational only — the `leadgen`
 * subscription is page-wide, so this doesn't gate anything; it just lets
 * the admin confirm they connected the page they meant to.
 */
export async function listLeadForms(
  pageId: string,
  pageAccessToken: string,
): Promise<MetaLeadForm[]> {
  const data = await graphGet<{ data?: MetaLeadForm[] }>(`${pageId}/leadgen_forms`, {
    fields: 'id,name,status',
    limit: '100',
    access_token: pageAccessToken,
  });
  return data.data ?? [];
}

/** Absolute expiry from Meta's relative `expires_in`, when present. */
export function expiryFromNow(expiresIn: number | undefined): string | null {
  if (!expiresIn || !Number.isFinite(expiresIn)) return null;
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}
