import { describe, expect, it } from 'vitest';

import {
  createPlan,
  isMissing084,
  registerAdvance,
  registerPayment,
  rejectVoucher,
  voidPayment,
} from './rpc';

type Call = { fn: string; args: Record<string, unknown> };

function fakeClient(result: { data?: unknown; error?: { code?: string; message: string } | null }) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return { data: result.data ?? null, error: result.error ?? null };
      },
    },
  };
}

const missing = { code: 'PGRST202', message: 'Could not find the function public.x in the schema cache' };

describe('isMissing084', () => {
  it('reconoce PGRST202 y nada más', () => {
    expect(isMissing084(missing)).toBe(true);
    expect(isMissing084({ code: '42501', message: 'nope' })).toBe(false);
    expect(isMissing084(null)).toBe(false);
  });
});

describe('rpc wrappers', () => {
  it('registerPayment llama al RPC con parámetros p_*', async () => {
    const f = fakeClient({});
    const r = await registerPayment(f.client, {
      installmentId: 'i1',
      amount: 150.5,
      method: 'Yape',
      reference: '123',
      voucherPath: null,
      paidOn: '2026-11-09',
    });
    expect(r).toEqual({ ok: true });
    expect(f.calls[0]).toEqual({
      fn: 'register_installment_payment',
      args: {
        p_installment_id: 'i1',
        p_amount: 150.5,
        p_method: 'Yape',
        p_reference: '123',
        p_voucher_path: null,
        p_paid_on: '2026-11-09',
      },
    });
  });

  it('registerAdvance', async () => {
    const f = fakeClient({});
    const r = await registerAdvance(f.client, { planId: 'p', installmentIds: ['a', 'b'] });
    expect(r).toEqual({ ok: true });
    expect(f.calls[0].fn).toBe('register_advance_payment');
    expect(f.calls[0].args.p_installment_ids).toEqual(['a', 'b']);
    expect(f.calls[0].args.p_plan_id).toBe('p');
  });

  it('voidPayment', async () => {
    const f = fakeClient({});
    expect(await voidPayment(f.client, { paymentId: 'x', reason: 'error de monto' })).toEqual({ ok: true });
    expect(f.calls[0]).toEqual({
      fn: 'void_installment_payment',
      args: { p_payment_id: 'x', p_reason: 'error de monto' },
    });
  });

  it('rejectVoucher', async () => {
    const f = fakeClient({});
    expect(await rejectVoucher(f.client, { installmentId: 'i1', reason: 'borroso' })).toEqual({ ok: true });
    expect(f.calls[0]).toEqual({
      fn: 'reject_client_voucher',
      args: { p_installment_id: 'i1', p_reason: 'borroso' },
    });
  });

  it('createPlan manda el jsonb como p', async () => {
    const f = fakeClient({});
    expect(await createPlan(f.client, { currency: 'PEN' })).toEqual({ ok: true });
    expect(f.calls[0]).toEqual({ fn: 'create_payment_plan', args: { p: { currency: 'PEN' } } });
  });

  it('RPC inexistente → missing084', async () => {
    const f = fakeClient({ error: missing });
    const r = await voidPayment(f.client, { paymentId: 'x', reason: 'r' });
    expect(r).toEqual({ ok: false, missing084: true, message: expect.stringContaining('084') });
  });

  it('error normal → mensaje de la base', async () => {
    const f = fakeClient({ error: { code: '22023', message: 'No supera lo que falta' } });
    const r = await registerPayment(f.client, { installmentId: 'i', amount: 1 });
    expect(r).toEqual({ ok: false, missing084: false, message: 'No supera lo que falta' });
  });
});
