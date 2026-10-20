import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { validateCommand } from '@/lib/cash/model';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
function databaseError(error: { code?: string }) {
  if (error.code === '42501')
    return json(
      {
        error:
          'No tienes permiso para esta operación. Solicita acceso al propietario.',
      },
      403
    );
  if (error.code === '40001')
    return json({ error: 'Este movimiento cambió mientras lo editabas. Actualiza la caja y revisa los datos.' }, 409);
  if (['PGRST202', '42P01', '42883'].includes(error.code ?? ''))
    return json(
      {
        error:
          'Caja aún no está habilitada en esta instalación. Revisa las migraciones 063, 064 y 065.',
      },
      503
    );
  if (
    [
      '22023',
      '22007',
      '22008',
      '22P02',
      '23502',
      '23503',
      '23505',
      '23514',
    ].includes(error.code ?? '')
  )
    return json(
      {
        error:
          'Revisa los datos. El nombre puede estar en uso o el movimiento ya fue anulado.',
      },
      400
    );
  return json(
    {
      error:
        'No se pudo completar la operación. Puedes reintentar sin duplicar el registro.',
    },
    500
  );
}
export async function GET(request?: Request) {
  try {
    const { supabase } = await getCurrentAccount();
    const companyId = request ? new URL(request.url).searchParams.get('companyId') : null;
    if (companyId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId))
      return json({ error: 'Empresa no válida.' }, 400);
    const { data, error } = companyId
      ? await supabase.rpc('cash_company_snapshot', { p_company: companyId })
      : await supabase.rpc('cash_company_list');
    return error ? databaseError(error) : json(data);
  } catch (error) {
    return toErrorResponse(error);
  }
}
export async function POST(request: Request) {
  // Same-origin session cookies; no cross-origin mutation surface.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin)
    return json({ error: 'Origen no permitido.' }, 403);
  try {
    const { supabase } = await getCurrentAccount();
    let command: Record<string, unknown>;
    try {
      command = validateCommand(await request.json());
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : 'Datos no válidos.' },
        400
      );
    }
    const { data, error } = await supabase.rpc('cash_company_command', {
      p_command: command,
    });
    return error ? databaseError(error) : json({ id: data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
