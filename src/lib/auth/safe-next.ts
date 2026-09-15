// ============================================================
// Where to send someone after an email link.
//
// The destination travels in the link (`next`), so anyone could
// craft one. Only paths on this same site are followed; anything
// else — another domain, "//evil.com" — falls back to the default.
// ============================================================

export function safeNext(
  raw: string | null | undefined,
  origin: string,
  fallback = "/dashboard",
): string {
  if (!raw) return fallback;
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) return fallback;
    return url.pathname + url.search;
  } catch {
    return fallback;
  }
}

/** The invitation token when `path` is /join/<token>, otherwise null. */
export function inviteTokenFromPath(path: string): string | null {
  const match = path.match(/^\/join\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}
