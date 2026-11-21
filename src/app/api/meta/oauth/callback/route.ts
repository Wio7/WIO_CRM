import { NextResponse } from 'next/server';

import type { SupabaseClient } from '@supabase/supabase-js';

import { requireRole } from '@/lib/auth/account';
import { getBaseUrl } from '@/lib/auth/invitations';
import { origenPermitido } from '@/lib/cors';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  expiryFromNow,
  fetchMe,
  instagramDePagina,
  listPages,
  META_OAUTH_SCOPES,
  subscribePageToApp,
  verifyState,
  verifyStateCompleto,
} from '@/lib/meta-leads/oauth';

/** "https://broker.wiocompany.com/#/conectar" + meta=ok → "…/#/conectar?meta=ok". */
export function volverConResultado(volver: string, resultado: Record<string, string>): string {
  const q = new URLSearchParams(resultado).toString();
  return `${volver}${volver.includes('?') ? '&' : '?'}${q}`;
}

/**
 * Desde la app nadie va a la pantalla de Configuración a encender cada
 * página: se activan todas para mensajes (Messenger e Instagram) al volver.
 */
async function activarPaginas(db: SupabaseClient, accountId: string, pages: { id: string; access_token: string }[]) {
  for (const page of pages) {
    try {
      const { messaging } = await subscribePageToApp(page.id, page.access_token);
      const ig = await instagramDePagina(page.id, page.access_token).catch(() => null);
      await db
        .from('meta_pages')
        .update({
          is_active: true,
          subscribed_at: new Date().toISOString(),
          messaging_at: messaging ? new Date().toISOString() : null,
          instagram_id: ig?.id ?? null,
          instagram_username: ig?.username ?? null,
          last_error: null,
        })
        .eq('account_id', accountId)
        .eq('page_id', page.id);
    } catch (err) {
      await db
        .from('meta_pages')
        .update({ last_error: err instanceof Error ? err.message : 'No se pudo activar la página.' })
        .eq('account_id', accountId)
        .eq('page_id', page.id);
    }
  }
}

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

  // ¿Viene de la app de un cliente? Entonces el `state` firmado trae a dónde
  // volver y quién conectó (esa app no tiene la cookie del CRM).
  const estado = verifyStateCompleto(new URL(request.url).searchParams.get('state'));
  const desdeApp =
    estado?.desdeApp && origenPermitido(new URL(estado.desdeApp.volver).origin) ? estado.desdeApp : null;

  const fail = (msg: string) =>
    desdeApp
      ? NextResponse.redirect(volverConResultado(desdeApp.volver, { meta_error: msg }))
      : NextResponse.redirect(`${settingsUrl}&error=${encodeURIComponent(msg)}`);

  try {
    const url = new URL(request.url);

    // The user hit "Cancelar" on Meta's consent screen.
    const metaError = url.searchParams.get('error_description') ?? url.searchParams.get('error');
    if (metaError) return fail(metaError);

    const code = url.searchParams.get('code');
    if (!code) return fail('Meta no devolvió un código de autorización.');

    let supabase: SupabaseClient;
    let accountId: string;
    let userId: string;
    if (desdeApp && estado) {
      // El `state` lo firmó el servidor para un dueño/administrador con
      // sesión, vence a los 10 min y no se puede alterar. Igual se vuelve a
      // comprobar que esa persona sigue siendo dueña o administradora.
      supabase = supabaseAdmin();
      accountId = estado.accountId;
      userId = desdeApp.userId;
      const { data: perfil } = await supabase
        .from('profiles')
        .select('account_role')
        .eq('user_id', userId)
        .eq('account_id', accountId)
        .maybeSingle();
      if (!perfil || !['owner', 'admin'].includes(perfil.account_role as string)) {
        return fail('Solo el dueño o un administrador puede conectar Facebook e Instagram.');
      }
    } else {
      // The session is the authority on which account we're writing to.
      // `state` must agree — it's what proves this callback belongs to a
      // flow we started (CSRF), and a mismatch means the browser switched
      // accounts mid-flow, so we refuse rather than cross-write tenants.
      ({ supabase, accountId, userId } = await requireRole('admin'));
      const stateAccountId = verifyState(url.searchParams.get('state'));
      if (!stateAccountId) {
        return fail('La sesión de conexión expiró o no es válida. Intenta de nuevo.');
      }
      if (stateAccountId !== accountId) {
        return fail('La conexión se inició desde otra cuenta. Vuelve a intentarlo.');
      }
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

    if (desdeApp) {
      const propias = pages.filter((p) => !claimed.includes(p.name || p.id));
      await activarPaginas(supabase, accountId, propias);
      return NextResponse.redirect(
        volverConResultado(desdeApp.volver, {
          meta: 'ok',
          paginas: String(propias.length),
          ...(claimed.length ? { omitidas: claimed.join(', ') } : {}),
        }),
      );
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
