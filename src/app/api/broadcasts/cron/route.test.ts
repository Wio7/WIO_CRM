import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runBroadcastDispatch = vi.fn();
vi.mock('@/lib/whatsapp/broadcast-dispatch', () => ({
  runBroadcastDispatch: (...args: unknown[]) => runBroadcastDispatch(...args),
}));
vi.mock('@/lib/calls/admin-client', () => ({
  supabaseAdmin: () => ({ fake: 'admin' }),
}));

import { GET, maxDuration } from './route';

function request(headers: Record<string, string> = {}) {
  return new Request('https://crm.test/api/broadcasts/cron', { headers });
}

describe('GET /api/broadcasts/cron auth', () => {
  beforeEach(() => {
    runBroadcastDispatch.mockResolvedValue({ claimed: 1, outcomes: [] });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    runBroadcastDispatch.mockReset();
  });

  it('allows up to 300 s', () => {
    expect(maxDuration).toBe(300);
  });

  it('answers 503 when no secret is configured', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', '');
    vi.stubEnv('CRON_SECRET', '');
    const res = await GET(request({ 'x-cron-secret': 'anything' }));
    expect(res.status).toBe(503);
    expect(runBroadcastDispatch).not.toHaveBeenCalled();
  });

  it('answers 401 without or with a wrong secret', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', 'right-secret');
    vi.stubEnv('CRON_SECRET', 'vercel-secret');
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request({ 'x-cron-secret': 'wrong-secret' }))).status).toBe(401);
    expect((await GET(request({ 'x-cron-secret': 'right-secre' }))).status).toBe(401);
    expect((await GET(request({ authorization: 'Bearer nope' }))).status).toBe(401);
    // The header secret is not valid as a Bearer token, nor vice versa.
    expect((await GET(request({ authorization: 'Bearer right-secret' }))).status).toBe(401);
    expect((await GET(request({ 'x-cron-secret': 'vercel-secret' }))).status).toBe(401);
    expect(runBroadcastDispatch).not.toHaveBeenCalled();
  });

  it('runs the dispatcher with x-cron-secret', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', 'right-secret');
    vi.stubEnv('CRON_SECRET', '');
    const res = await GET(request({ 'x-cron-secret': 'right-secret' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimed: 1, outcomes: [] });
    expect(runBroadcastDispatch).toHaveBeenCalledTimes(1);
    expect(runBroadcastDispatch.mock.calls[0][0]).toEqual({ fake: 'admin' });
  });

  it('runs the dispatcher with a Vercel Bearer token', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', '');
    vi.stubEnv('CRON_SECRET', 'vercel-secret');
    const res = await GET(request({ authorization: 'Bearer vercel-secret' }));
    expect(res.status).toBe(200);
    expect(runBroadcastDispatch).toHaveBeenCalledTimes(1);
  });

  it('answers 500 (no details) when the dispatcher throws', async () => {
    vi.stubEnv('AUTOMATION_CRON_SECRET', 'right-secret');
    runBroadcastDispatch.mockRejectedValue(new Error('secret internals'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(request({ 'x-cron-secret': 'right-secret' }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret internals');
  });
});
