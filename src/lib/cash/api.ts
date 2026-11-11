import { NextResponse } from 'next/server';

export const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Errores de base de datos de las rutas nuevas de caja (087). */
export function dbError(error: { code?: string; message?: string }) {
  if (error.code === '42501') return json({ error: 'No tienes permiso para esta operación.' }, 403);
  if (['PGRST202', '42P01', '42883'].includes(error.code ?? ''))
    return json({ error: 'Falta aplicar la migración 087 de la caja.' }, 503);
  if (['22023', '22P02', '23503', '23514'].includes(error.code ?? ''))
    return json({ error: error.message || 'Revisa los datos.' }, 400);
  return json({ error: 'No se pudo completar la operación.' }, 500);
}
