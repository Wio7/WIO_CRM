// ============================================================
// Client portal identity — pure helpers, no Supabase.
//
// Clients of an account with `client_portal_enabled` (migration 045)
// sign into the Golden App with their phone and their DNI. Everything
// here is deterministic so the rules can be tested without a database:
// how a typed phone maps to stored phones, what a valid DNI looks like,
// when to lock, and how session tokens are minted and stored.
// ============================================================

import { createHash, randomBytes } from "node:crypto";

/** Failed tries on one phone before it locks. */
export const MAX_FAILS_PER_PHONE = 5;
/** Window those tries are counted in; also how long the lock lasts. */
export const PHONE_WINDOW_MS = 15 * 60_000;
/** Tries from one IP, successful or not, before it locks. A family on
 *  one Wi-Fi signs in a handful of times; a script tries thousands. */
export const MAX_TRIES_PER_IP = 30;
export const IP_WINDOW_MS = 60 * 60_000;
/** A client opens the app about once a month: the session outlives that
 *  comfortably and is extended on every visit. */
export const SESSION_TTL_MS = 180 * 24 * 60 * 60_000;

/** Peru's country code. Contacts that came in through WhatsApp are
 *  stored with it; clients type the 9-digit mobile without it. */
const PERU = "51";

/**
 * The stored `phone_normalized` values a typed phone could match.
 * "987 654 321", "+51 987654321" and "0051987654321" all find a contact
 * saved as "51987654321" or as "987654321".
 */
export function phoneCandidates(input: string): string[] {
  let digits = String(input ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length < 7 || digits.length > 15) return [];

  const out = new Set<string>([digits]);
  if (digits.length === 9 && digits.startsWith("9")) out.add(PERU + digits);
  if (digits.length === 11 && digits.startsWith(PERU + "9")) out.add(digits.slice(2));
  return [...out];
}

/** Digits of the typed phone, as recorded in the attempts table. */
export function phoneKey(input: string): string {
  return phoneCandidates(input).find((c) => c.length === 11 && c.startsWith(PERU)) ??
    phoneCandidates(input)[0] ??
    "";
}

/**
 * DNI as stored by 044: digits only, 8 to 12. Spaces, dots and dashes a
 * client might type are dropped; anything else makes it invalid.
 */
export function normalizeDni(input: string): string | null {
  const raw = String(input ?? "").trim();
  if (/[^0-9\s.-]/.test(raw)) return null;
  const digits = raw.replace(/\D/g, "");
  return /^[0-9]{8,12}$/.test(digits) ? digits : null;
}

/** Constant-time string comparison for the DNI check. */
export function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0 && a.length === b.length;
}

export interface Attempt {
  succeeded: boolean;
  created_at: string;
}

/** Times of the failures inside the window since the last success, newest first. */
export function failsSinceSuccess(attempts: Attempt[], now = Date.now()): number[] {
  const recent = attempts
    .filter((a) => now - Date.parse(a.created_at) < PHONE_WINDOW_MS)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

  const fails: number[] = [];
  for (const a of recent) {
    if (a.succeeded) break;
    fails.push(Date.parse(a.created_at));
  }
  return fails;
}

/**
 * When a phone unlocks, or null if it isn't locked. Only failures since
 * the last success count: a client who mistyped twice last week and got
 * in yesterday starts from zero.
 */
export function phoneLockedUntil(attempts: Attempt[], now = Date.now()): number | null {
  const fails = failsSinceSuccess(attempts, now);
  if (fails.length < MAX_FAILS_PER_PHONE) return null;
  // Locked until the oldest counted failure leaves the window.
  return fails[MAX_FAILS_PER_PHONE - 1] + PHONE_WINDOW_MS;
}

/** When an IP unlocks, or null. */
export function ipLockedUntil(attempts: Attempt[], now = Date.now()): number | null {
  const recent = attempts
    .map((a) => Date.parse(a.created_at))
    .filter((t) => now - t < IP_WINDOW_MS)
    .sort((a, b) => b - a);
  if (recent.length < MAX_TRIES_PER_IP) return null;
  return recent[MAX_TRIES_PER_IP - 1] + IP_WINDOW_MS;
}

/** A new opaque session token: returned once, stored only as its hash. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** First name for the greeting: "PEREZ ROJAS, Juan Carlos" → "Juan". */
export function firstName(name: string | null | undefined): string {
  const clean = String(name ?? "").trim();
  if (!clean) return "";
  const afterComma = clean.includes(",") ? clean.split(",")[1].trim() : clean;
  const first = afterComma.split(/\s+/)[0] ?? "";
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/** "51987654321" → "••• ••• 321": enough for the client to recognise it. */
export function maskPhone(phone: string | null | undefined): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.length >= 3 ? `••• ••• ${digits.slice(-3)}` : "";
}
