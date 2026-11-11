import { beforeEach, describe, expect, it, vi } from 'vitest';
const { rpc, account } = vi.hoisted(() => ({ rpc: vi.fn(), account: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: account,
  toErrorResponse: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
import { POST } from './route';
import { GET as panel } from '../panel/route';
const E = '00000000-0000-0000-0000-000000000001';
const P = '00000000-0000-0000-0000-000000000002';
const post = (body: unknown) =>
  POST(new Request('https://crm.test/api/caja/clasificar', { method: 'POST', body: JSON.stringify(body) }));
beforeEach(() => {
  vi.resetAllMocks();
  account.mockResolvedValue({ supabase: { rpc } });
  rpc.mockResolvedValue({ data: {}, error: null });
});
describe('clasificar un gasto', () => {
  it('llama a la base con proyecto y rubro', async () => {
    expect((await post({ entryId: E, projectId: P, rubro: 'obra' })).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('cash_classify_entry', { p_entry: E, p_project: P, p_general: false, p_rubro: 'obra' });
    await post({ entryId: E, projectGeneral: true, rubro: 'combi' });
    expect(rpc).toHaveBeenLastCalledWith('cash_classify_entry', { p_entry: E, p_project: null, p_general: true, p_rubro: 'combi' });
  });
  it('rechaza datos incompletos o inventados sin llamar a la base', async () => {
    for (const body of [
      { entryId: E, rubro: 'obra' },
      { entryId: E, projectId: P },
      { entryId: E, projectId: P, rubro: 'x' },
      { entryId: E, projectId: P, projectGeneral: true, rubro: 'obra' },
      { entryId: 'no', projectId: P, rubro: 'obra' },
    ])
      expect((await post(body)).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('sin permiso devuelve 403', async () => {
    rpc.mockResolvedValue({ error: { code: '42501' } });
    expect((await post({ entryId: E, projectId: P, rubro: 'obra' })).status).toBe(403);
  });
});
describe('panel de gerencia', () => {
  it('pasa mes y caja, y valida el formato', async () => {
    expect((await panel(new Request(`https://crm.test/api/caja/panel?month=2026-11&companyId=${P}`))).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('cash_management_panel', { p_month: '2026-11-01', p_company: P });
    expect((await panel(new Request('https://crm.test/api/caja/panel?month=2026-13'))).status).toBe(400);
    rpc.mockResolvedValue({ error: { code: '42501' } });
    expect((await panel(new Request('https://crm.test/api/caja/panel'))).status).toBe(403);
  });
});
