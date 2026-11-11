import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { esRubro } from '@/lib/cash/clasificar';
import { dbError, json, UUID } from '@/lib/cash/api';

// Completar proyecto y rubro de un gasto ya registrado.
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Origen no permitido.' }, 403);
  try {
    const { supabase } = await getCurrentAccount();
    const b = (await request.json().catch(() => null)) as
      | { entryId?: string; projectId?: string | null; projectGeneral?: boolean; rubro?: string }
      | null;
    const general = b?.projectGeneral === true;
    if (!b || !UUID.test(b.entryId ?? '') || !esRubro(b.rubro) || general === Boolean(b.projectId) ||
        (b.projectId && !UUID.test(b.projectId)))
      return json({ error: 'Elige el rubro y el proyecto (o gasto general).' }, 400);
    const { error } = await supabase.rpc('cash_classify_entry', {
      p_entry: b.entryId, p_project: b.projectId || null, p_general: general, p_rubro: b.rubro,
    });
    return error ? dbError(error) : json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
