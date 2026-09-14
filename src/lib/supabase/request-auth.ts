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
import { headers } from 'next/headers';

import { createClient as createCookieClient } from '@/lib/supabase/server';

export interface RequestAuth {
  supabase: SupabaseClient;
  user: User | null;
}

function sessionTokenFrom(authorization: string | null): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  if (!token || token.startsWith('wacrm_')) return null;
  return token;
}

/** The Supabase JWT from `Authorization: Bearer …`, if one was sent. */
export function bearerSessionToken(request: Request): string | null {
  return sessionTokenFrom(request.headers.get('authorization'));
}

async function resolveAuth(token: string | null): Promise<RequestAuth> {
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

export async function getRequestAuth(request: Request): Promise<RequestAuth> {
  return resolveAuth(bearerSessionToken(request));
}

/**
 * Same as `getRequestAuth` for server helpers that don't receive the
 * Request (e.g. `getCurrentAccount`): reads the incoming headers.
 * Outside a request scope (unit tests) it falls back to the cookie path.
 */
export async function getIncomingRequestAuth(): Promise<RequestAuth> {
  let authorization: string | null = null;
  try {
    authorization = (await headers()).get('authorization');
  } catch {
    authorization = null;
  }
  return resolveAuth(sessionTokenFrom(authorization));
}
