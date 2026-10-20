import { beforeEach, describe, expect, it, vi } from 'vitest';
const { rpc, account } = vi.hoisted(() => ({ rpc: vi.fn(), account: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: account,
  toErrorResponse: () =>
    Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
import { GET, POST } from './route';
beforeEach(() => {
  vi.resetAllMocks();
  account.mockResolvedValue({ supabase: { rpc } });
});
describe('cash API', () => {
  it('returns an uncached authorized snapshot', async () => {
    rpc.mockResolvedValue({
      data: { income: 500000, expense: 10000 },
      error: null,
    });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(rpc).toHaveBeenCalledWith('cash_company_list');
    await GET(new Request('https://crm.test/api/caja?companyId=00000000-0000-0000-0000-000000000001'));
    expect(rpc).toHaveBeenCalledWith('cash_company_snapshot', { p_company: '00000000-0000-0000-0000-000000000001' });
  });
  it('does not call the database without a session', async () => {
    account.mockRejectedValue(new Error('Unauthorized'));
    expect((await GET()).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('denies access and identifies a missing migration', async () => {
    rpc.mockResolvedValue({ error: { code: '42501' } });
    expect((await GET()).status).toBe(403);
    rpc.mockResolvedValue({ error: { code: 'PGRST202' } });
    expect((await GET()).status).toBe(503);
  });
  it('rejects cross-origin writes before authentication and rejects invalid payloads', async () => {
    const response = await POST(
      new Request('https://crm.test/api/caja', {
        method: 'POST',
        headers: { origin: 'https://evil.test' },
        body: '{}',
      })
    );
    expect(response.status).toBe(403);
    expect(account).not.toHaveBeenCalled();
    expect(
      (
        await POST(
          new Request('https://crm.test/api/caja', {
            method: 'POST',
            body: '{',
          })
        )
      ).status
    ).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});
