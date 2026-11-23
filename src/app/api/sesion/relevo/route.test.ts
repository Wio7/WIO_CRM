import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getRequestAuth = vi.fn();
const generateLink = vi.fn();
let perfilArea: string | null = null;
vi.mock('@/lib/supabase/request-auth', () => ({
  getRequestAuth: (...args: unknown[]) => getRequestAuth(...args),
}));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { area: perfilArea }, error: null }) }),
      }),
    }),
    auth: { admin: { generateLink: (...args: unknown[]) => generateLink(...args) } },
  }),
}));

import { OPTIONS, POST } from './route';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

const ORIGEN = 'https://golden-habitat-studios.vercel.app';

function request(headers: Record<string, string> = {}, method = 'POST') {
  return new Request('https://crm.test/api/sesion/relevo', { method, headers });
}
const BEARER = { authorization: 'Bearer token-del-usuario', origin: ORIGEN };

describe('POST /api/sesion/relevo', () => {
  beforeEach(() => {
    vi.stubEnv('APP_CORS_ORIGINS', `${ORIGEN},http://localhost:5173`);
    perfilArea = 'ventas';
    getRequestAuth.mockResolvedValue({ user: { id: 'u1', email: 'a@b.com' } });
    generateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'hash-123' } },
      error: null,
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    getRequestAuth.mockReset();
    generateLink.mockReset();
    __resetRateLimitForTests();
  });

  it('401 sin cabecera Bearer', async () => {
    const res = await POST(request({ origin: ORIGEN }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'sesion' });
    expect(generateLink).not.toHaveBeenCalled();
  });

  it('401 con token inválido', async () => {
    getRequestAuth.mockResolvedValue({ user: null });
    const res = await POST(request(BEARER));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'sesion' });
    expect(generateLink).not.toHaveBeenCalled();
  });

  it('403 para el área externa promueve', async () => {
    perfilArea = 'promueve';
    const res = await POST(request(BEARER));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'externo' });
    expect(generateLink).not.toHaveBeenCalled();
  });

  it('200 devuelve token_hash y pide magiclink sin enviar correo', async () => {
    const res = await POST(request(BEARER));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token_hash: 'hash-123' });
    expect(generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'a@b.com' });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGEN);
  });

  it('502 si Supabase no devuelve hash', async () => {
    generateLink.mockResolvedValue({ data: { properties: {} }, error: null });
    const res = await POST(request(BEARER));
    expect(res.status).toBe(502);
  });

  it('429 al pasar el límite por usuario', async () => {
    let ultimo: Response | undefined;
    for (let i = 0; i < 21; i++) ultimo = await POST(request(BEARER));
    expect(ultimo!.status).toBe(429);
  });

  it('OPTIONS responde el preflight solo a orígenes permitidos', () => {
    const ok = OPTIONS(request({ origin: ORIGEN }, 'OPTIONS'));
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGEN);
    const local = OPTIONS(request({ origin: 'http://localhost:5173' }, 'OPTIONS'));
    expect(local.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const malo = OPTIONS(request({ origin: 'https://evil.example' }, 'OPTIONS'));
    expect(malo.headers.get('access-control-allow-origin')).toBeNull();
  });
});
