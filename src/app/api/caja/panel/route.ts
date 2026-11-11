import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { dbError, json, UUID } from '@/lib/cash/api';

// Panel de gerencia: ?month=AAAA-MM (vacío = todo el historial) y ?companyId=.
export async function GET(request: Request) {
  try {
    const { supabase } = await getCurrentAccount();
    const params = new URL(request.url).searchParams;
    const month = params.get('month');
    const companyId = params.get('companyId');
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ error: 'Mes no válido.' }, 400);
    if (companyId && !UUID.test(companyId)) return json({ error: 'Caja no válida.' }, 400);
    const { data, error } = await supabase.rpc('cash_management_panel', {
      p_month: month ? `${month}-01` : null,
      p_company: companyId || null,
    });
    return error ? dbError(error) : json(data);
  } catch (error) {
    return toErrorResponse(error);
  }
}
