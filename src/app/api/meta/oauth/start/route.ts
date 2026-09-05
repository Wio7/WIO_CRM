import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { getBaseUrl } from '@/lib/auth/invitations';
import { buildAuthorizeUrl } from '@/lib/meta-leads/oauth';

/**
 * GET /api/meta/oauth/start  (admin+)
 *
 * Kicks off "Conectar con Facebook": signs the caller's account into the
 * `state` parameter and redirects to Meta's consent screen. The admin
 * authenticates on facebook.com — no credential ever reaches us.
 *
 * A plain redirect (not JSON) so the settings page can link straight here.
 */
export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('admin');

    if (!process.env.META_APP_ID) {
      return NextResponse.redirect(
        `${getBaseUrl(request)}/settings?tab=meta-leads&error=${encodeURIComponent(
          'META_APP_ID no está configurado en el servidor.',
        )}`,
      );
    }

    const redirectUri = `${getBaseUrl(request)}/api/meta/oauth/callback`;
    return NextResponse.redirect(buildAuthorizeUrl(accountId, redirectUri));
  } catch (err) {
    return toErrorResponse(err);
  }
}
