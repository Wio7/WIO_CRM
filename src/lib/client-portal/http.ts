// Request helpers shared by the /api/client/* routes.

/** First hop of X-Forwarded-For (Vercel sets it), else X-Real-IP. */
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** The client session token from `Authorization: Bearer …`. */
export function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}
