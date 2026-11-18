import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createBroadcast, BroadcastError, sendTemplateWithVariants } from './broadcast-core';
import { FakeDb } from '@/lib/test-support/fake-db';

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => `dec:${s}` }));
vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(async (_db: unknown, _acc: string, _u: string, i: { phone: string }) => ({ id: 'c-' + i.phone, created: true })),
}));

// These assertions all fire in the pure validation prologue, before
// any Supabase call — a bare stub is enough.
const db = {} as SupabaseClient;

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from({ length: 1001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients })
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('sendTemplateWithVariants', () => {
  const base = {
    phoneNumberId: 'pn',
    accessToken: 'tok',
    phone: '37063949836',
    templateName: 'promo',
    language: 'es',
    template: null,
    params: ['a'],
  };

  it('stops at the first success', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: 'wamid-1' });
    const out = await sendTemplateWithVariants({ ...base, send });
    expect(out).toMatchObject({ messageId: 'wamid-1', error: null });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe('37063949836');
  });

  it('tries the next phone variant only on "not in allowed list"', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('(#131030) Recipient phone number not in allowed list'))
      .mockResolvedValueOnce({ messageId: 'wamid-2' });
    const out = await sendTemplateWithVariants({ ...base, send });
    expect(out.messageId).toBe('wamid-2');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].to).not.toBe(send.mock.calls[0][0].to);
  });

  it('does not retry other errors and reports them', async () => {
    const send = vi.fn().mockRejectedValue(new Error('template paused'));
    const out = await sendTemplateWithVariants({ ...base, send });
    expect(out).toMatchObject({ messageId: null, error: 'template paused' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('createBroadcast con líneas', () => {
  const ACC = 'acc-1';
  const mk = (over: Record<string, unknown> = {}) => ({
    id: 'line-a',
    account_id: ACC,
    line_name: 'Principal',
    phone_number_id: 'pn-a',
    access_token: 'enc-a',
    is_primary: true,
    sort_order: 0,
    disconnected_at: null,
    ...over,
  });
  const lineB = (over: Record<string, unknown> = {}) =>
    mk({ id: 'line-b', line_name: 'Posventa', phone_number_id: 'pn-b', is_primary: false, sort_order: 1, ...over });
  const run = (lines: Record<string, unknown>[], lineId?: string) => {
    const fake = new FakeDb({ whatsapp_config: lines as never });
    return createBroadcast(fake.asClient(), ACC, 'user', {
      templateName: 'promo',
      recipients: [{ to: '+51999111222' }],
      lineId,
    });
  };

  it('sin lineId usa la línea principal', async () => {
    const plan = await run([lineB(), mk()]);
    expect(plan.phoneNumberId).toBe('pn-a');
    expect(plan.accessToken).toBe('dec:enc-a');
  });

  it('con lineId usa esa línea', async () => {
    const plan = await run([mk(), lineB()], 'line-b');
    expect(plan.phoneNumberId).toBe('pn-b');
  });

  it('lineId de otra cuenta: 404', async () => {
    await expect(run([mk(), lineB({ account_id: 'acc-2' })], 'line-b')).rejects.toMatchObject({
      code: 'line_not_found',
      status: 404,
    });
  });

  it('línea desconectada: 503 con mensaje claro', async () => {
    await expect(
      run([mk(), lineB({ disconnected_at: '2026-11-01T00:00:00Z' })], 'line-b'),
    ).rejects.toMatchObject({ code: 'line_unavailable', status: 503, message: expect.stringContaining('desconectada') });
  });
});
