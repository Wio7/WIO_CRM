// ============================================================
// Resolve the signed-in user of a dashboard API request.
//
// The dashboard authenticates with Supabase cookies. A companion app on
// another origin (the Golden App) has no cookies for this domain, so it
// sends the advisor's Supabase access token instead:
//
//   Authorization: Bearer <supabase access token>
//
// Either way the returned client runs under that user's RLS, so the
// route's existing account checks apply unchanged. Public-API keys
// (`wacrm_…`) are NOT accepted here — those go through `requireApiKey`.
// ============================================================

import {
  createClient as createSupabaseClient,
  type SupabaseClient,
  type User,
} from '@supabase/supabase-js';

import { createClient as createCookieClient } from '@/lib/supabase/server';

/** The Supabase JWT from `Authorization: Bearer …`, if one was sent. */
export function bearerSessionToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  if (!token || token.startsWith('wacrm_')) return null;
  return token;
}

export async function getRequestAuth(
  request: Request
): Promise<{ supabase: SupabaseClient; user: User | null }> {
  const token = bearerSessionToken(request);

  if (token) {
    const supabase = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      }
    );
    const { data, error } = await supabase.auth.getUser(token);
    return { supabase, user: error ? null : data.user };
  }

  const supabase = (await createCookieClient()) as unknown as SupabaseClient;
  const { data, error } = await supabase.auth.getUser();
  return { supabase, user: error ? null : data.user };
}
