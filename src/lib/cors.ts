// ============================================================
// CORS for first-party apps that live on another origin.
//
// The Golden App (golden 3d) is a static site on its own domain that
// reads the shared inbox straight from Supabase (RLS-scoped to the
// advisor) and calls a handful of dashboard routes — send, media —
// with the advisor's Supabase access token. Browsers only allow that
// cross-origin call when the route answers with CORS headers.
//
// Allow-listed, never `*`: set APP_CORS_ORIGINS to a comma-separated
// list of exact origins (scheme + host [+ port], no trailing slash).
// Unset → no CORS headers at all, so behaviour is unchanged for
// deployments that don't run a companion app.
// ============================================================

function allowedOrigins(): string[] {
  return (process.env.APP_CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** CORS headers for this request, or `{}` if its origin isn't allowed. */
export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins().includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/** Copy the CORS headers onto a response the route already built. */
export function withCors<T extends Response>(request: Request, response: T): T {
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    response.headers.set(key, value);
  }
  return response;
}

/** Answer a CORS preflight (`OPTIONS`). */
export function corsPreflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
