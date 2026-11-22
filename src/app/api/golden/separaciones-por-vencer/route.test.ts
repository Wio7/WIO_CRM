import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const notifyUsers = vi.fn();
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: (...args: unknown[]) => rpc(...args) }),
}));
vi.mock('@/lib/push/send', () => ({
  notifyUsers: (...args: unknown[]) => notifyUsers(...args),
}));

import { GET } from './route';

function request(headers: Record<string, string> = {}) {
  return new Request('https://crm.test/api/golden/separaciones-por-vencer', { headers });
}

const AUTH = { 'x-cron-secret': 'right-secret' };

describe('GET /api/golden/separaciones-por-vencer', () => {
  beforeEach(() => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', 'right-secret');
    vi.stubEnv('CRON_SECRET', 'vercel-secret');
    notifyUsers.mockResolvedValue(2);
    rpc.mockResolvedValue({ data: [], error: null });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rpc.mockReset();
    notifyUsers.mockReset();
    vi.restoreAllMocks();
  });

  it('responde 503 sin secretos configurados', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', '');
    vi.stubEnv('CRON_SECRET', '');
    const res = await GET(request(AUTH));
    expect(res.status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('responde 401 con secreto malo o ausente', async () => {
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request({ 'x-cron-secret': 'wrong-secret' }))).status).toBe(401);
    expect((await GET(request({ authorization: 'Bearer nope' }))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('acepta el Bearer de Vercel Cron', async () => {
    const res = await GET(request({ authorization: 'Bearer vercel-secret' }));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('gh_por_vencer_aviso', { p_dias: 7 });
  });

  it('avisa a los destinatarios con el texto en singular y en plural', async () => {
    rpc.mockResolvedValue({
      data: [
        { account_id: 'a1', cantidad: 1, destinatarios: ['u1', 'u2'] },
        { account_id: 'a2', cantidad: 3, destinatarios: ['u3'] },
      ],
      error: null,
    });
    const res = await GET(request(AUTH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cuentas: 2, enviados: 4 });
    expect(notifyUsers).toHaveBeenCalledTimes(2);
    expect(notifyUsers.mock.calls[0][1]).toEqual({
      userIds: ['u1', 'u2'],
      title: 'Separaciones por vencer',
      body: '1 separación pasó 7 días sin completar la inicial. Revisa y decide si liberar.',
      url: 'https://gerencia-golden.vercel.app/aprobaciones',
      tag: 'golden-por-vencer',
    });
    expect(notifyUsers.mock.calls[1][1]).toMatchObject({
      userIds: ['u3'],
      body: '3 separaciones pasaron 7 días sin completar la inicial. Revisa y decide si liberar.',
    });
  });

  it('no envía cuando la cantidad es 0 o no hay destinatarios', async () => {
    rpc.mockResolvedValue({
      data: [
        { account_id: 'a1', cantidad: 0, destinatarios: ['u1'] },
        { account_id: 'a2', cantidad: 2, destinatarios: [] },
        { account_id: 'a3', cantidad: 2, destinatarios: null },
      ],
      error: null,
    });
    const res = await GET(request(AUTH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cuentas: 0, enviados: 0 });
    expect(notifyUsers).not.toHaveBeenCalled();
  });

  it('responde 500 y loguea si la RPC falla', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc.mockResolvedValue({ data: null, error: { message: 'function does not exist' } });
    const res = await GET(request(AUTH));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false });
    expect(log).toHaveBeenCalled();
    expect(notifyUsers).not.toHaveBeenCalled();
  });
});
