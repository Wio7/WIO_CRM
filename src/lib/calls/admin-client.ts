import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for the Power Dialer.
// Mirrors src/lib/flows/admin-client.ts and src/lib/automations/admin-client.ts —
// same shape so anyone reading any of them picks up the convention immediately.
//
// The dialer needs this because Twilio webhooks arrive with no user
// session (no auth.uid()), so RLS can't scope them. That cuts both ways:
// this client bypasses RLS entirely, so EVERY query in the dialer must
// carry an explicit `.eq('account_id', ...)`. The automations engine
// does the same and comments on it at each call site.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
