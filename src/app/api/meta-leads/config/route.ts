// ============================================================
// GET/POST/DELETE /api/meta-leads/config
//
// Dashboard config for the per-account Meta Lead Ads integration
// (migration 036). Uses the caller's RLS session client, so the
// admin-only RLS policies on `meta_leads_config` enforce authorization —
// a non-admin's write is rejected by the database, not by app code.
//
// Secrets are AES-256-GCM encrypted before storage and NEVER returned by
// GET (only booleans indicating whether each is set). The account's
// webhook URL — the thing the user pastes into Meta — is derived from
// the stored `webhook_token`.
// ============================================================

import crypto from 'node:crypto';
import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { encrypt } from '@/lib/whatsapp/encryption';

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle();
  return (data?.account_id as string | undefined) ?? null;
}

/** Absolute origin for building the webhook URL shown to the user. */
function resolveOrigin(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/$/, '');
  return new URL(request.url).origin;
}

function webhookUrl(request: Request, token: string): string {
  return `${resolveOrigin(request)}/api/meta/leads/${token}`;
}

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accountId = await resolveAccountId(supabase, user.id);
    if (!accountId) {
      return NextResponse.json({ configured: false, reason: 'no_account' });
    }

    const { data: config } = await supabase
      .from('meta_leads_config')
      .select(
        'webhook_token, verify_token, page_id, is_active, app_secret, page_access_token'
      )
      .eq('account_id', accountId)
      .maybeSingle();

    if (!config) {
      return NextResponse.json({ configured: false });
    }

    return NextResponse.json({
      configured: true,
      is_active: config.is_active,
      webhook_url: webhookUrl(request, config.webhook_token),
      verify_token: config.verify_token ?? '',
      page_id: config.page_id ?? '',
      has_app_secret: !!config.app_secret,
      has_page_access_token: !!config.page_access_token,
    });
  } catch (err) {
    console.error('[meta-leads/config GET]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accountId = await resolveAccountId(supabase, user.id);
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const appSecret = str(body.app_secret);
    const verifyToken = str(body.verify_token);
    const pageAccessToken = str(body.page_access_token);
    const pageId = str(body.page_id);
    const isActive =
      typeof body.is_active === 'boolean' ? body.is_active : true;

    // Preserve the existing webhook_token (and any secret the user left
    // blank this save) rather than regenerating it — the token is baked
    // into the URL already registered in Meta.
    const { data: existing } = await supabase
      .from('meta_leads_config')
      .select('webhook_token, app_secret, page_access_token')
      .eq('account_id', accountId)
      .maybeSingle();

    const token =
      (existing?.webhook_token as string | undefined) ??
      crypto.randomBytes(24).toString('hex');

    let encryptedAppSecret: string | null =
      (existing?.app_secret as string | undefined) ?? null;
    let encryptedPageToken: string | null =
      (existing?.page_access_token as string | undefined) ?? null;
    try {
      if (appSecret) encryptedAppSecret = encrypt(appSecret);
      if (pageAccessToken) encryptedPageToken = encrypt(pageAccessToken);
    } catch (err) {
      console.error('[meta-leads/config POST] encryption failed:', err);
      return NextResponse.json(
        {
          error:
            'Failed to encrypt credentials. Check that ENCRYPTION_KEY is a valid 64-character hex string.',
        },
        { status: 500 }
      );
    }

    const row = {
      account_id: accountId,
      user_id: user.id,
      webhook_token: token,
      app_secret: encryptedAppSecret,
      verify_token: verifyToken || null,
      page_access_token: encryptedPageToken,
      page_id: pageId || null,
      is_active: isActive,
      updated_at: new Date().toISOString(),
    };

    // Upsert on the account_id PK. RLS (admin-only) authorizes the write.
    const { error } = await supabase
      .from('meta_leads_config')
      .upsert(row, { onConflict: 'account_id' });
    if (error) {
      console.error('[meta-leads/config POST] upsert failed:', error);
      return NextResponse.json(
        { error: 'Failed to save configuration' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      webhook_url: webhookUrl(request, token),
    });
  } catch (err) {
    console.error('[meta-leads/config POST]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accountId = await resolveAccountId(supabase, user.id);
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    const { error } = await supabase
      .from('meta_leads_config')
      .delete()
      .eq('account_id', accountId);
    if (error) {
      console.error('[meta-leads/config DELETE] failed:', error);
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[meta-leads/config DELETE]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
