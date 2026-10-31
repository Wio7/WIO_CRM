import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createBroadcast, BroadcastError, sendTemplateWithVariants } from './broadcast-core';

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
