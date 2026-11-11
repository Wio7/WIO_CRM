import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { dbError, json, UUID } from '@/lib/cash/api';

// Sin companyId: ¿esta persona tiene el panel de gerencia? Con companyId:
// proyectos, rubros y responsable de esa caja para el formulario.
export async function GET(request: Request) {
  try {
    const { supabase } = await getCurrentAccount();
    const companyId = new URL(request.url).searchParams.get('companyId');
    if (companyId && !UUID.test(companyId)) return json({ error: 'Caja no válida.' }, 400);
    const { data, error } = companyId
      ? await supabase.rpc('cash_form_options', { p_company: companyId })
      : await supabase.rpc('cash_access_info');
    return error ? dbError(error) : json(data);
  } catch (error) {
    return toErrorResponse(error);
  }
}

// Cambiar el responsable de una caja (solo su dueño; lo vuelve a comprobar la base).
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Origen no permitido.' }, 403);
  try {
    const { supabase } = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as { companyId?: string; userId?: string | null } | null;
    if (!body || !UUID.test(body.companyId ?? '') || (body.userId != null && !UUID.test(body.userId)))
      return json({ error: 'Datos no válidos.' }, 400);
    const { error } = await supabase.rpc('cash_set_responsible', { p_company: body.companyId, p_user: body.userId ?? null });
    return error ? dbError(error) : json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
