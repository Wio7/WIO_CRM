// ============================================================
// Email an account invitation through Supabase Auth.
//
//   · New address → auth.admin.inviteUserByEmail. Supabase creates the
//     user (the signup trigger gives them an empty personal account) and
//     emails a link that signs them in and lands on /join/<token>, where
//     they set a password and accept.
//   · Address that already has a login → a magic link (signInWithOtp)
//     to the same /join/<token> page.
//
// Delivery uses the project's Supabase email settings. The built-in
// sender is heavily rate-limited; configure custom SMTP for real use.
// The invite link is still returned to the inviter, so a failed email
// never loses the invitation.
// ============================================================

import { createClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/flows/admin-client';

export type InviteEmailResult =
  | { sent: true; kind: 'invite' | 'magic_link' }
  | { sent: false; error: string };

function isAlreadyRegistered(error: { message?: string; status?: number; code?: string }) {
  return (
    error.code === 'email_exists' ||
    error.status === 422 ||
    /already (been )?registered|already exists/i.test(error.message ?? '')
  );
}

export async function sendInviteEmail(
  email: string,
  redirectTo: string,
  fullName: string | null
): Promise<InviteEmailResult> {
  const { error } = await supabaseAdmin().auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data: fullName ? { full_name: fullName } : undefined,
  });
  if (!error) return { sent: true, kind: 'invite' };
  if (!isAlreadyRegistered(error)) {
    console.error('[invite-email] invite failed:', error.message);
    return { sent: false, error: error.message };
  }

  const anon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  );
  const { error: otpError } = await anon.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
  });
  if (otpError) {
    console.error('[invite-email] magic link failed:', otpError.message);
    return { sent: false, error: otpError.message };
  }
  return { sent: true, kind: 'magic_link' };
}
