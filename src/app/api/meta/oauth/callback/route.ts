import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { getBaseUrl } from '@/lib/auth/invitations';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  expiryFromNow,
  fetchMe,
  listPages,
  META_OAUTH_SCOPES,
  verifyState,
} from '@/lib/meta-leads/oauth';

/**
 * GET /api/meta/oauth/callback
 *
 * Where Meta sends the admin back after the consent screen. Runs the
 * token chain (code → short-lived → long-lived → Page tokens), persists
 * everything encrypted, and bounces to the settings tab.
 *
 * Always redirects — never renders JSON or a stack trace, because a human
 * in a browser lands here. Failures come back as `?error=<mensaje>` for
 * the settings page to surface.
 *
 * Pages are stored but NOT auto-subscribed: the admin picks which ones
 * feed the CRM from the settings UI. Connecting shouldn't silently start
 * ingesting leads from every page the user happens to manage.
 */
export async function GET(request: Request) {
  const base = getBaseUrl(request);
  const settingsUrl = `${base}/settings?tab=meta-leads`;
  const fail = (msg: string) =>
    NextResponse.redirect(`${settingsUrl}&error=${encodeURIComponent(msg)}`);

  try {
    const url = new URL(request.url);

    // The user hit "Cancelar" on Meta's consent screen.
    const metaError = url.searchParams.get('error_description') ?? url.searchParams.get('error');
    if (metaError) return fail(metaError);

    const code = url.searchParams.get('code');
    if (!code) return fail('Meta no devolvió un código de autorización.');

    // The session is the authority on which account we're writing to.
    // `state` must agree — it's what proves this callback belongs to a
    // flow we started (CSRF), and a mismatch means the browser switched
    // accounts mid-flow, so we refuse rather than cross-write tenants.
    const { supabase, accountId, userId } = await requireRole('admin');
    const stateAccountId = verifyState(url.searchParams.get('state'));
    if (!stateAccountId) {
      return fail('La sesión de conexión expiró o no es válida. Intenta de nuevo.');
    }
    if (stateAccountId !== accountId) {
      return fail('La conexión se inició desde otra cuenta. Vuelve a intentarlo.');
    }

    const redirectUri = `${base}/api/meta/oauth/callback`;

    // Order matters: exchange to long-lived BEFORE listing pages, so the
    // derived Page tokens are non-expiring. See src/lib/meta-leads/oauth.ts.
    const shortLived = await exchangeCodeForToken(code, redirectUri);
    const longLived = await exchangeForLongLivedToken(shortLived.access_token);
    const me = await fetchMe(longLived.access_token);
    const pages = await listPages(longLived.access_token);

    const { error: connErr } = await supabase.from('meta_connections').upsert(
      {
        account_id: accountId,
        connected_by: userId,
        fb_user_id: me.id,
        fb_user_name: me.name ?? null,
        user_access_token: encrypt(longLived.access_token),
        token_expires_at: expiryFromNow(longLived.expires_in),
        scopes: [...META_OAUTH_SCOPES],
        connected_at: new Date().toISOString(),
        last_error: null,
      },
      { onConflict: 'account_id' },
    );
    if (connErr) {
      console.error('[meta oauth callback] connection upsert failed:', connErr);
      return fail('No se pudo guardar la conexión.');
    }

    // Upsert page-by-page: a page already claimed by ANOTHER account trips
    // the global unique index (see migration 037). That's one page we skip
    // and report, not a reason to abandon the whole connection.
    const claimed: string[] = [];
    for (const page of pages) {
      const { error } = await supabase.from('meta_pages').upsert(
        {
          account_id: accountId,
          page_id: page.id,
          page_name: page.name,
          page_access_token: encrypt(page.access_token),
          last_error: null,
        },
        { onConflict: 'account_id,page_id' },
      );
      if (error) {
        // 23505 on the global index = the page belongs to another tenant.
        if (error.code === '23505') claimed.push(page.name || page.id);
        else console.error('[meta oauth callback] page upsert failed:', page.id, error);
      }
    }

    const params = new URLSearchParams({ connected: '1', pages: String(pages.length) });
    if (claimed.length > 0) {
      params.set(
        'warning',
        `Estas páginas ya están conectadas a otra cuenta y se omitieron: ${claimed.join(', ')}`,
      );
    }
    return NextResponse.redirect(`${settingsUrl}&${params.toString()}`);
  } catch (err) {
    console.error('[meta oauth callback] error:', err);
    return fail(err instanceof Error ? err.message : 'Error al conectar con Facebook.');
  }
}
