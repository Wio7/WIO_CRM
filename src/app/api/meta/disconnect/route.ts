import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { decrypt } from '@/lib/whatsapp/encryption';
import { unsubscribePageFromApp } from '@/lib/meta-leads/oauth';

/**
 * DELETE /api/meta/disconnect  (admin+)
 *
 * Tears down the Facebook connection: unsubscribes every active page at
 * Meta, then drops the stored tokens and pages.
 *
 * Unsubscribing is best-effort — a revoked or expired token makes the
 * Graph call fail, but that also means Meta already stopped delivering,
 * so a failure there must not block us from clearing local state.
 * Otherwise a user whose token died could never disconnect and reconnect.
 */
export async function DELETE() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`meta-disconnect:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { data: pages } = await supabase
      .from('meta_pages')
      .select('page_id, page_access_token, is_active')
      .eq('account_id', accountId);

    for (const page of pages ?? []) {
      if (!page.is_active || !page.page_access_token) continue;
      try {
        await unsubscribePageFromApp(page.page_id, decrypt(page.page_access_token));
      } catch (err) {
        console.warn('[meta/disconnect] unsubscribe failed for', page.page_id, err);
      }
    }

    const { error: pagesErr } = await supabase
      .from('meta_pages')
      .delete()
      .eq('account_id', accountId);
    const { error: connErr } = await supabase
      .from('meta_connections')
      .delete()
      .eq('account_id', accountId);

    if (pagesErr || connErr) {
      console.error('[meta/disconnect] delete failed:', pagesErr ?? connErr);
      return NextResponse.json({ error: 'No se pudo desconectar' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
