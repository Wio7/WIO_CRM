// ============================================================
// GET /api/v1/store/catalog — catalogo y datos de pago de la tienda
// (scope: store:read). Lo llama el SERVIDOR de la tienda web con la API
// key de la cuenta; no hay CORS a proposito.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { loadCatalog } from '@/lib/store/service';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'store:read');
    return ok(await loadCatalog(ctx.supabase, ctx.accountId));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
