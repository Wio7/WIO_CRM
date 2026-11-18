import { NextResponse } from 'next/server';

import { LineNotFoundError, LineUnavailableError } from '@/lib/whatsapp/lines';

/**
 * Respuesta HTTP para los errores de resolveAccountLine: línea que no es de
 * la cuenta -> 404; desconectada o ilegible -> 503 (igual que los envíos).
 * Devuelve null si el error es otro (el llamador lo vuelve a lanzar).
 */
export function lineErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof LineNotFoundError) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  if (err instanceof LineUnavailableError) {
    return NextResponse.json({ error: err.message }, { status: 503 });
  }
  return null;
}
