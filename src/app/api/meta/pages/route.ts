import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  listLeadForms,
  subscribePageToApp,
  unsubscribePageFromApp,
} from '@/lib/meta-leads/oauth';

interface PageRow {
  id: string;
  page_id: string;
  page_name: string | null;
  page_access_token: string | null;
  subscribed_at: string | null;
  is_active: boolean;
  last_error: string | null;
}

/**
 * GET /api/meta/pages  (admin+)
 *
 * The connection status card: who authorized, plus every Page we know
 * about and whether it's feeding leads. Page tokens are never returned —
 * only whether one exists.
 *
 * `?forms=<page_id>` additionally returns that page's lead forms, fetched
 * live from Meta. Kept opt-in rather than loading forms for every page on
 * render, since it's one Graph round-trip per page.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');

    const [{ data: connection }, { data: pages }] = await Promise.all([
      supabase
        .from('meta_connections')
        .select('fb_user_id, fb_user_name, token_expires_at, connected_at, scopes, last_error')
        .eq('account_id', accountId)
        .maybeSingle(),
      supabase
        .from('meta_pages')
        .select('id, page_id, page_name, page_access_token, subscribed_at, is_active, last_error')
        .eq('account_id', accountId)
        .order('page_name', { ascending: true }),
    ]);

    const rows = (pages ?? []) as PageRow[];

    const formsFor = new URL(request.url).searchParams.get('forms');
    let forms: { id: string; name?: string; status?: string }[] | null = null;
    if (formsFor) {
      const target = rows.find((p) => p.page_id === formsFor);
      if (target?.page_access_token) {
        try {
          forms = await listLeadForms(target.page_id, decrypt(target.page_access_token));
        } catch (err) {
          console.error('[meta/pages] listLeadForms failed:', err);
          forms = [];
        }
      }
    }

    return NextResponse.json({
      connected: !!connection,
      connection: connection
        ? {
            fb_user_name: connection.fb_user_name,
            connected_at: connection.connected_at,
            token_expires_at: connection.token_expires_at,
            last_error: connection.last_error,
          }
        : null,
      pages: rows.map((p) => ({
        id: p.id,
        page_id: p.page_id,
        page_name: p.page_name,
        is_active: p.is_active,
        subscribed_at: p.subscribed_at,
        has_token: !!p.page_access_token,
        last_error: p.last_error,
      })),
      forms,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PATCH /api/meta/pages  (admin+)
 *
 * Body: `{ page_id, is_active }`. Toggling a page on subscribes it to our
 * app's `leadgen` field at Meta; toggling off unsubscribes. The DB flag
 * only flips if the Graph call succeeded, so the switch always reflects
 * what Meta actually believes — a page showing "activa" that isn't
 * subscribed would silently drop every lead.
 */
export async function PATCH(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`meta-pages:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { page_id?: unknown; is_active?: unknown }
      | null;
    const pageId = typeof body?.page_id === 'string' ? body.page_id : null;
    const isActive = body?.is_active;
    if (!pageId || typeof isActive !== 'boolean') {
      return NextResponse.json(
        { error: 'page_id (string) e is_active (boolean) son requeridos' },
        { status: 400 },
      );
    }

    const { data: page, error: fetchErr } = await supabase
      .from('meta_pages')
      .select('id, page_id, page_access_token')
      .eq('account_id', accountId)
      .eq('page_id', pageId)
      .maybeSingle();
    if (fetchErr || !page) {
      return NextResponse.json({ error: 'Página no encontrada' }, { status: 404 });
    }
    if (!page.page_access_token) {
      return NextResponse.json(
        { error: 'La página no tiene token. Vuelve a conectar Facebook.' },
        { status: 400 },
      );
    }

    let pageToken: string;
    try {
      pageToken = decrypt(page.page_access_token);
    } catch {
      return NextResponse.json(
        { error: 'No se pudo descifrar el token de la página. Reconecta Facebook.' },
        { status: 500 },
      );
    }

    try {
      if (isActive) await subscribePageToApp(pageId, pageToken);
      else await unsubscribePageFromApp(pageId, pageToken);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error al comunicar con Meta';
      // Record why, so the UI can explain instead of just failing.
      await supabase
        .from('meta_pages')
        .update({ last_error: message })
        .eq('id', page.id);
      return NextResponse.json({ error: message }, { status: 502 });
    }

    const { error: updateErr } = await supabase
      .from('meta_pages')
      .update({
        is_active: isActive,
        subscribed_at: isActive ? new Date().toISOString() : null,
        last_error: null,
      })
      .eq('id', page.id);
    if (updateErr) {
      console.error('[meta/pages PATCH] update failed:', updateErr);
      return NextResponse.json({ error: 'No se pudo guardar el cambio' }, { status: 500 });
    }

    return NextResponse.json({ success: true, page_id: pageId, is_active: isActive });
  } catch (err) {
    return toErrorResponse(err);
  }
}
