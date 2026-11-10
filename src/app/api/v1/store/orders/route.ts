// ============================================================
// POST /api/v1/store/orders — crea un pedido de la tienda
// (scope: store:write). Lo llama el SERVIDOR de la tienda web con la API
// key de la cuenta. El total NUNCA se toma del cuerpo: la base lo calcula
// con los precios de los productos activos de la cuenta.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { fail, ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseOrderBody } from '@/lib/store/order';
import { createStoreOrder } from '@/lib/store/service';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'store:write');

    const body = await request.json().catch(() => null);
    const parsed = parseOrderBody(body);
    if (!parsed.ok) return fail('bad_request', parsed.message, 400);

    const result = await createStoreOrder(ctx.supabase, ctx.accountId, parsed.value);
    if (!result.ok) return fail(result.code, result.message, result.status);

    return ok({ order: result.order }, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
