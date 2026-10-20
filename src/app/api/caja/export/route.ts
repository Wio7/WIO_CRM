import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { cashWorkbook } from '@/lib/cash/xlsx';
import type { CashAudit, CashEntry } from '@/lib/cash/model';

export async function GET(request: Request) {
  try {
    const companyId = new URL(request.url).searchParams.get('companyId');
    if (!companyId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId))
      return Response.json({ error: 'Empresa no válida.' }, { status: 400 });
    const { supabase } = await getCurrentAccount();
    const { data, error } = await supabase.rpc('cash_company_export', { p_company: companyId });
    if (error) return Response.json({ error: 'No se pudo descargar la caja.' }, { status: error.code === '42501' ? 403 : 503 });
    const payload = data as { entries: CashEntry[]; audit: CashAudit[] };
    const bytes = cashWorkbook(payload.entries, payload.audit);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="golden-caja.xlsx"',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) { return toErrorResponse(error); }
}
