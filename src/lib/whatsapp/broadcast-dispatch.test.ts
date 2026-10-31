import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeDb, type Row } from '@/lib/test-support/fake-db';
import { cancelScheduledBroadcast } from './broadcast-audience';
import { runBroadcastDispatch, type DispatchOptions } from './broadcast-dispatch';
import { MetaApiError, type sendTemplateMessage } from './meta-api';

const T0 = Date.parse('2026-11-05T15:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const A = 'acc-a';
const B = 'acc-b';

interface SendCall {
  to: string;
  accessToken: string;
  phoneNumberId: string;
  params?: string[];
  messageParams?: { headerMediaUrl?: string };
}

class Harness {
  clock = { t: T0 };
  db: FakeDb;
  calls: SendCall[] = [];
  failPhones = new Set<string>();

  constructor(seed: Record<string, Row[]> = {}) {
    this.db = new FakeDb(seed);
    this.db.now = () => this.clock.t;
  }

  send = vi.fn(async (args: Parameters<typeof sendTemplateMessage>[0]) => {
    this.calls.push({
      to: args.to,
      accessToken: args.accessToken,
      phoneNumberId: args.phoneNumberId,
      params: args.params,
      messageParams: args.messageParams,
    });
    if (this.failPhones.has(args.to)) throw new Error('boom');
    return { messageId: `wamid-${args.to}` };
  }) as unknown as typeof sendTemplateMessage;

  run(options: DispatchOptions = {}, send = this.send) {
    return runBroadcastDispatch(this.db.asClient(), options, {
      now: () => this.clock.t,
      sleep: async (ms) => {
        this.clock.t += ms;
      },
      send,
      decryptToken: (s) => `dec:${s}`,
    });
  }

  row(table: string, id: string): Row {
    return this.db.table(table).find((r) => r.id === id)!;
  }

  statuses(broadcastId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.table('broadcast_recipients')) {
      if (r.broadcast_id !== broadcastId) continue;
      out[r.status as string] = (out[r.status as string] ?? 0) + 1;
    }
    return out;
  }
}

function account(id: string, suffix = id): Record<string, Row[]> {
  return {
    whatsapp_config: [{ id: `cfg-${id}`, account_id: id, phone_number_id: `pn-${id}`, access_token: `enc-${suffix}` }],
    message_templates: [
      { id: `tpl-${id}`, user_id: 'u', account_id: id, name: 'promo', language: 'es', body_text: 'Hola {{1}}' },
    ],
  };
}

function merge(...parts: Record<string, Row[]>[]): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const part of parts) for (const [k, v] of Object.entries(part)) (out[k] ??= []).push(...v);
  return out;
}

function broadcast(overrides: Row = {}): Row {
  return {
    id: 'b1',
    account_id: A,
    user_id: 'u',
    name: 'Prueba',
    template_name: 'promo',
    template_language: 'es',
    template_variables: { '1': { type: 'field', value: 'name' } },
    audience_filter: { type: 'all', dispatch: 'server' },
    scheduled_at: iso(T0 - 1000),
    status: 'scheduled',
    updated_at: iso(T0 - 3_600_000),
    ...overrides,
  };
}

/** n contacts + n pending recipients for a broadcast. */
function audience(n: number, broadcastId = 'b1', accountId = A, tag = 'x'): Record<string, Row[]> {
  const contacts: Row[] = [];
  const recipients: Row[] = [];
  for (let i = 0; i < n; i++) {
    const k = String(i).padStart(5, '0');
    contacts.push({
      id: `c-${tag}-${k}`,
      account_id: accountId,
      name: `Persona ${i}`,
      phone: `${accountId === B ? '5191' : '5190'}${String(i).padStart(7, '0')}`,
    });
    recipients.push({
      id: `r-${tag}-${k}`,
      broadcast_id: broadcastId,
      contact_id: `c-${tag}-${k}`,
      status: 'pending',
    });
  }
  return { contacts, broadcast_recipients: recipients };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('which broadcasts are eligible', () => {
  it('ignores rows without dispatch = server, even if scheduled/due or stale sending', async () => {
    const h = new Harness(
      merge(account(A), audience(5), {
        broadcasts: [
          broadcast({ id: 'old-scheduled', audience_filter: { type: 'all' } }),
          broadcast({ id: 'null-filter', audience_filter: null }),
          broadcast({ id: 'other-marker', audience_filter: { dispatch: 'browser' } }),
          broadcast({ id: 'old-sending', status: 'sending', audience_filter: { type: 'all' } }),
        ],
      }),
    );
    const summary = await h.run();
    expect(summary).toEqual({ claimed: 0, outcomes: [] });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.db.table('broadcasts').map((b) => b.status)).toEqual([
      'scheduled',
      'scheduled',
      'scheduled',
      'sending',
    ]);
  });

  it('does not take future, cancelled (draft) or date-less broadcasts', async () => {
    const h = new Harness(
      merge(account(A), audience(3, 'future'), {
        broadcasts: [
          broadcast({ id: 'future', scheduled_at: iso(T0 + 60_000) }),
          broadcast({ id: 'cancelled', status: 'draft' }),
          broadcast({ id: 'no-date', scheduled_at: null }),
        ],
      }),
    );
    expect((await h.run()).claimed).toBe(0);
    expect(h.send).not.toHaveBeenCalled();

    // One minute later the future one is due.
    h.clock.t += 61_000;
    expect((await h.run()).claimed).toBe(1);
    expect(h.row('broadcasts', 'future').status).toBe('sent');
    expect(h.row('broadcasts', 'cancelled').status).toBe('draft');
  });

  it('leaves a fresh (leased) sending broadcast alone', async () => {
    const h = new Harness(
      merge(account(A), audience(3), {
        broadcasts: [broadcast({ status: 'sending', updated_at: iso(T0 - 30_000) })],
      }),
    );
    expect((await h.run()).claimed).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('no one is messaged twice', () => {
  it('two simultaneous runs send each recipient exactly once', async () => {
    const h = new Harness(merge(account(A), audience(25), { broadcasts: [broadcast()] }));
    const [one, two] = await Promise.all([h.run(), h.run()]);
    expect(one.claimed + two.claimed).toBe(1);
    expect(h.calls).toHaveLength(25);
    expect(new Set(h.calls.map((c) => c.to)).size).toBe(25);
    expect(h.row('broadcasts', 'b1').status).toBe('sent');
  });

  it('claims a stale lease only if it is unchanged since it was read', async () => {
    const h = new Harness(
      merge(account(A), audience(3), {
        broadcasts: [broadcast({ status: 'sending', updated_at: iso(T0 - 120_000) })],
      }),
    );
    // Another run touches the row between our read and our claim.
    h.db.beforeExec = (q) => {
      if (q.table === 'broadcasts' && q.op === 'update') {
        h.row('broadcasts', 'b1').updated_at = iso(T0);
        h.db.beforeExec = undefined;
      }
    };
    expect((await h.run()).claimed).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('only updates recipients that are still pending, and never re-sends settled ones', async () => {
    const data = audience(4);
    data.broadcast_recipients[0].status = 'sent';
    data.broadcast_recipients[1].status = 'delivered';
    data.broadcast_recipients[2].status = 'failed';
    const h = new Harness(merge(account(A), data, { broadcasts: [broadcast()] }));
    await h.run();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].to).toBe('51900000003');
    expect(h.row('broadcast_recipients', 'r-x-00000').status).toBe('sent');
    expect(h.row('broadcast_recipients', 'r-x-00001').status).toBe('delivered');
    const updates = h.db.log.filter((l) => l.table === 'broadcast_recipients' && l.op === 'update');
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      expect(u.filters).toContainEqual({ kind: 'eq', col: 'status', value: 'pending' });
    }
  });

  it('a recipient settled elsewhere meanwhile is not overwritten', async () => {
    const h = new Harness(merge(account(A), audience(1), { broadcasts: [broadcast()] }));
    h.db.beforeExec = (q) => {
      if (q.table === 'broadcast_recipients' && q.op === 'update') {
        h.row('broadcast_recipients', 'r-x-00000').status = 'delivered';
        h.db.beforeExec = undefined;
      }
    };
    await h.run();
    expect(h.row('broadcast_recipients', 'r-x-00000').status).toBe('delivered');
  });

  it('stops without re-sending when a sent message cannot be recorded', async () => {
    const h = new Harness(merge(account(A), audience(5), { broadcasts: [broadcast()] }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.db.failNext('broadcast_recipients', 'update', { message: 'db down' }, 1000);
    const summary = await h.run();
    expect(summary.outcomes[0].result).toBe('failed');
    expect(h.row('broadcasts', 'b1').status).toBe('failed');
    expect(errors).toHaveBeenCalled();
    // The failed broadcast is never picked up again.
    h.clock.t += 600_000;
    const before = h.calls.length;
    await h.run();
    expect(h.calls).toHaveLength(before);
  });
});

describe('cancel vs claim', () => {
  it('a cancelled broadcast never goes out', async () => {
    const h = new Harness(merge(account(A), audience(3), { broadcasts: [broadcast()] }));
    expect(await cancelScheduledBroadcast(h.db.asClient(), 'b1')).toEqual({ cancelled: true });
    expect((await h.run()).claimed).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.row('broadcasts', 'b1').status).toBe('draft');
  });

  it('once claimed, cancel changes nothing', async () => {
    const h = new Harness(merge(account(A), audience(3), { broadcasts: [broadcast()] }));
    await h.run();
    expect(await cancelScheduledBroadcast(h.db.asClient(), 'b1')).toEqual({ cancelled: false });
    expect(h.row('broadcasts', 'b1').status).toBe('sent');
  });

  it('cancel in the gap between read and claim wins; the claim matches nothing', async () => {
    const h = new Harness(merge(account(A), audience(3), { broadcasts: [broadcast()] }));
    h.db.beforeExec = (q) => {
      if (q.table === 'broadcasts' && q.op === 'update') {
        h.row('broadcasts', 'b1').status = 'draft';
        h.db.beforeExec = undefined;
      }
    };
    expect((await h.run()).claimed).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('time budget and resuming', () => {
  it('leaves pending recipients for the next run and finishes them later, once each', async () => {
    const h = new Harness(merge(account(A), audience(100), { broadcasts: [broadcast()] }));

    const first = await h.run({ budgetMs: 5000 });
    expect(first.outcomes[0].result).toBe('budget');
    expect(h.calls).toHaveLength(50);
    expect(h.statuses('b1')).toEqual({ sent: 50, pending: 50 });
    expect(h.row('broadcasts', 'b1').status).toBe('sending');

    // Immediately after, the lease is still fresh: nobody else takes over.
    expect((await h.run()).claimed).toBe(0);
    expect(h.calls).toHaveLength(50);

    // Once the lease lapses the rest resumes.
    h.clock.t += 61_000;
    const second = await h.run();
    expect(second.outcomes[0].result).toBe('completed');
    expect(h.calls).toHaveLength(100);
    expect(new Set(h.calls.map((c) => c.to)).size).toBe(100);
    expect(h.statuses('b1')).toEqual({ sent: 100 });
    expect(h.row('broadcasts', 'b1').status).toBe('sent');
  });

  it('keeps the lease fresh while working (heartbeat at least every 20 s)', async () => {
    const h = new Harness(merge(account(A), audience(300), { broadcasts: [broadcast()] }));
    await h.run();
    const heartbeats = h.db.log.filter(
      (l) =>
        l.table === 'broadcasts' &&
        l.op === 'update' &&
        (l.payload as Row).status === 'sending' &&
        !l.filters.some((f) => f.col === 'updated_at'),
    );
    // 30 batches at 1 s each => work lasts ~30 s => at least one beat.
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
  });

  it('sends in batches of 10 with a 1 s pause', async () => {
    const h = new Harness(merge(account(A), audience(25), { broadcasts: [broadcast()] }));
    await h.run();
    expect(h.clock.t - T0).toBe(3000); // 3 batches, 1 s after each
  });
});

describe('1500 recipients', () => {
  it('sends all of them, reading pending in pages and contacts in chunks', async () => {
    const h = new Harness(merge(account(A), audience(1500), { broadcasts: [broadcast()] }));
    const summary = await h.run({ batchDelayMs: 0 });
    expect(summary.outcomes[0]).toMatchObject({ result: 'completed', sent: 1500, failed: 0 });
    expect(h.calls).toHaveLength(1500);
    expect(new Set(h.calls.map((c) => c.to)).size).toBe(1500);
    expect(h.statuses('b1')).toEqual({ sent: 1500 });
    expect(h.row('broadcasts', 'b1').status).toBe('sent');
    expect(Math.max(...h.db.inListSizes())).toBeLessThanOrEqual(100);
  });

  it('reads custom values beyond 1000 rows', async () => {
    const data = audience(60);
    // 60 contacts x 20 fields = 1200 custom-value rows.
    const values: Row[] = [];
    for (const c of data.contacts) {
      for (let f = 0; f < 20; f++) {
        values.push({ contact_id: c.id, custom_field_id: `f${f}`, value: `${c.id}:f${f}` });
      }
    }
    const h = new Harness(
      merge(account(A), data, {
        contact_custom_values: values,
        broadcasts: [
          broadcast({ template_variables: { '1': { type: 'custom_field', value: 'f19' } } }),
        ],
      }),
    );
    h.db.maxRows = 1000;
    await h.run({ batchDelayMs: 0 });
    expect(h.calls).toHaveLength(60);
    for (const call of h.calls) expect(call.params![0]).toMatch(/^c-x-\d+:f19$/);
  });
});

describe('final status', () => {
  it("is 'sent' when at least one went out", async () => {
    const h = new Harness(merge(account(A), audience(4), { broadcasts: [broadcast()] }));
    h.failPhones.add('51900000001');
    const summary = await h.run();
    expect(summary.outcomes[0]).toMatchObject({ result: 'completed', sent: 3, failed: 1 });
    expect(h.row('broadcasts', 'b1').status).toBe('sent');
    expect(h.row('broadcast_recipients', 'r-x-00001')).toMatchObject({
      status: 'failed',
      error_message: 'boom',
    });
  });

  it("is 'failed' when none went out", async () => {
    const h = new Harness(merge(account(A), audience(3), { broadcasts: [broadcast()] }));
    for (const r of h.db.table('contacts')) h.failPhones.add(r.phone as string);
    await h.run();
    expect(h.row('broadcasts', 'b1').status).toBe('failed');
    expect(h.statuses('b1')).toEqual({ failed: 3 });
  });

  it('stores whatsapp_message_id and sent_at so the webhook can match statuses', async () => {
    const h = new Harness(merge(account(A), audience(2), { broadcasts: [broadcast()] }));
    await h.run();
    const r = h.row('broadcast_recipients', 'r-x-00000');
    expect(r).toMatchObject({ status: 'sent', whatsapp_message_id: 'wamid-51900000000' });
    expect(r.sent_at).toBe(iso(T0));
  });

  it('never writes the count columns (the DB trigger owns them)', async () => {
    const h = new Harness(merge(account(A), audience(3), { broadcasts: [broadcast()] }));
    await h.run();
    const counts = ['sent_count', 'delivered_count', 'read_count', 'replied_count', 'failed_count', 'total_recipients'];
    for (const l of h.db.log.filter((x) => x.table === 'broadcasts' && x.op === 'update')) {
      for (const c of counts) expect(Object.keys(l.payload as Row)).not.toContain(c);
    }
  });
});

describe('configuration problems fail the broadcast with a logged reason', () => {
  it('missing whatsapp_config', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const data = account(A);
    data.whatsapp_config = [];
    const h = new Harness(merge(data, audience(2), { broadcasts: [broadcast()] }));
    const summary = await h.run();
    expect(summary.outcomes[0].result).toBe('failed');
    expect(h.row('broadcasts', 'b1').status).toBe('failed');
    expect(errors.mock.calls.flat().join(' ')).toMatch(/whatsapp_config/);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.statuses('b1')).toEqual({ pending: 2 });
  });

  it('missing template', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const data = account(A);
    data.message_templates = [];
    const h = new Harness(merge(data, audience(2), { broadcasts: [broadcast()] }));
    await h.run();
    expect(h.row('broadcasts', 'b1').status).toBe('failed');
    expect(errors.mock.calls.flat().join(' ')).toMatch(/plantilla promo/);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a template that belongs to another account does not count', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const data = account(A);
    data.message_templates = account(B).message_templates;
    const h = new Harness(merge(data, audience(2), { broadcasts: [broadcast()] }));
    await h.run();
    expect(h.row('broadcasts', 'b1').status).toBe('failed');
  });
});

describe('recipients that cannot be messaged do not block the queue', () => {
  it('contact deleted (contact_id NULL), no phone, invalid phone', async () => {
    const data = audience(5);
    data.broadcast_recipients[0].contact_id = null; // ON DELETE SET NULL
    data.contacts[1].phone = '';
    data.contacts[2].phone = '12';
    const h = new Harness(merge(account(A), data, { broadcasts: [broadcast()] }));
    const summary = await h.run();
    expect(summary.outcomes[0]).toMatchObject({ result: 'completed', sent: 2, failed: 3 });
    expect(h.row('broadcast_recipients', 'r-x-00000')).toMatchObject({
      status: 'failed',
      error_message: 'El contacto ya no existe',
    });
    expect(h.row('broadcast_recipients', 'r-x-00001').error_message).toBe('El contacto no tiene teléfono');
    expect(h.row('broadcast_recipients', 'r-x-00002').error_message).toBe('Número de teléfono inválido');
    expect(h.row('broadcasts', 'b1').status).toBe('sent');
  });

  it('a slow Meta call times out as failed instead of hanging the run', async () => {
    const h = new Harness(merge(account(A), audience(2), { broadcasts: [broadcast()] }));
    const hang = vi.fn(() => new Promise(() => {})) as unknown as typeof sendTemplateMessage;
    const summary = await h.run({ sendTimeoutMs: 20, batchSize: 2 }, hang);
    expect(summary.outcomes[0]).toMatchObject({ result: 'completed', failed: 2 });
    expect(String(h.row('broadcast_recipients', 'r-x-00000').error_message)).toMatch(/no respondió/);
    expect(h.row('broadcasts', 'b1').status).toBe('failed');
  });
});

describe('accounts stay separate', () => {
  it("each account's messages use that account's own token and number", async () => {
    const h = new Harness(
      merge(
        account(A),
        account(B),
        audience(3, 'bA', A, 'a'),
        audience(2, 'bB', B, 'b'),
        {
          broadcasts: [
            broadcast({ id: 'bA', account_id: A }),
            broadcast({ id: 'bB', account_id: B }),
          ],
        },
      ),
    );
    await h.run();
    const forA = h.calls.filter((c) => c.phoneNumberId === `pn-${A}`);
    const forB = h.calls.filter((c) => c.phoneNumberId === `pn-${B}`);
    expect(forA).toHaveLength(3);
    expect(forB).toHaveLength(2);
    expect(forA.every((c) => c.accessToken === 'dec:enc-acc-a')).toBe(true);
    expect(forB.every((c) => c.accessToken === 'dec:enc-acc-b')).toBe(true);
  });

  it("a recipient pointing at another account's contact is failed, not messaged", async () => {
    const data = merge(account(A), audience(2, 'bA', A, 'a'), audience(1, 'bB', B, 'b'), {
      broadcasts: [broadcast({ id: 'bA', account_id: A })],
    });
    // bA's second recipient references account B's contact.
    const foreign = data.contacts.find((c) => c.account_id === B)!;
    data.broadcast_recipients.find((r) => r.id === 'r-a-00001')!.contact_id = foreign.id;
    const h = new Harness(data);
    await h.run();
    expect(h.row('broadcast_recipients', 'r-a-00001')).toMatchObject({
      status: 'failed',
      error_message: 'El contacto ya no existe',
    });
    expect(h.calls.some((c) => c.to === foreign.phone)).toBe(false);
  });

  it('every account-owned query carries account_id', async () => {
    const h = new Harness(
      merge(account(A), account(B), audience(3, 'bA', A, 'a'), audience(2, 'bB', B, 'b'), {
        broadcasts: [broadcast({ id: 'bA', account_id: A }), broadcast({ id: 'bB', account_id: B })],
      }),
    );
    await h.run();
    const mustScope = ['contacts', 'whatsapp_config', 'message_templates'];
    for (const l of h.db.log) {
      const scoped = l.filters.some((f) => f.col === 'account_id' && f.kind === 'eq');
      if (mustScope.includes(l.table)) expect(scoped).toBe(true);
      // After the discovery query, broadcast writes name their account.
      if (l.table === 'broadcasts' && l.op === 'update') expect(scoped).toBe(true);
      // Recipients are only reached through a validated broadcast id.
      if (l.table === 'broadcast_recipients') {
        expect(
          l.filters.some((f) => f.col === 'broadcast_id') || l.filters.some((f) => f.col === 'id'),
        ).toBe(true);
      }
    }
  });
});

describe('template extras', () => {
  it('passes the header media URL for media-header templates', async () => {
    const data = account(A);
    data.message_templates[0].header_type = 'image';
    const h = new Harness(
      merge(data, audience(1), {
        broadcasts: [
          broadcast({ audience_filter: { dispatch: 'server', headerMediaUrl: 'https://x.test/a.jpg' } }),
        ],
      }),
    );
    await h.run();
    expect(h.calls[0].messageParams).toEqual({ headerMediaUrl: 'https://x.test/a.jpg' });
  });

  it('resolves body variables per contact', async () => {
    const h = new Harness(merge(account(A), audience(2), { broadcasts: [broadcast()] }));
    await h.run();
    expect(h.calls.map((c) => c.params)).toEqual([['Persona 0'], ['Persona 1']]);
  });
});

describe("Meta's answers", () => {
  const failingWith = (code: number, onlyTo?: string) =>
    vi.fn(async (args: Parameters<typeof sendTemplateMessage>[0]) => {
      if (!onlyTo || args.to === onlyTo) throw new MetaApiError('meta says no', code);
      return { messageId: `wamid-${args.to}` };
    }) as unknown as typeof sendTemplateMessage;

  it('a throughput error leaves recipients pending and the broadcast sending, then resumes', async () => {
    const h = new Harness(merge(account(A), audience(3), { broadcasts: [broadcast()] }));
    const first = await h.run({ batchSize: 3 }, failingWith(130429));
    expect(first.outcomes[0]).toMatchObject({ result: 'budget', sent: 0, failed: 0 });
    expect(h.statuses('b1')).toEqual({ pending: 3 });
    expect(h.row('broadcasts', 'b1').status).toBe('sending');

    h.clock.t += 61_000;
    await h.run({ batchSize: 3 });
    expect(h.statuses('b1')).toEqual({ sent: 3 });
    expect(h.row('broadcasts', 'b1').status).toBe('sent');
  });

  it('a payment error stops the broadcast, keeps the rest pending and records why', async () => {
    const h = new Harness(merge(account(A), audience(25), { broadcasts: [broadcast()] }));
    const send = failingWith(131042);
    const summary = await h.run({ batchSize: 10 }, send);
    expect(send).toHaveBeenCalledTimes(10);
    expect(summary.outcomes[0].result).toBe('failed');
    expect(h.statuses('b1')).toEqual({ pending: 25 });
    const b = h.row('broadcasts', 'b1');
    expect(b.status).toBe('failed');
    expect((b.audience_filter as Row).stopReason).toMatch(/método de pago/);
    expect((b.audience_filter as Row).dispatch).toBe('server');

    h.clock.t += 120_000;
    expect((await h.run()).claimed).toBe(0);
  });

  it('a paused template stops the broadcast', async () => {
    const h = new Harness(merge(account(A), audience(2), { broadcasts: [broadcast()] }));
    await h.run({ batchSize: 2 }, failingWith(132015));
    expect((h.row('broadcasts', 'b1').audience_filter as Row).stopReason).toMatch(/pausó la plantilla/);
  });

  it('an error about one person only fails that person', async () => {
    const h = new Harness(merge(account(A), audience(2), { broadcasts: [broadcast()] }));
    const phone = h.row('contacts', 'c-x-00000').phone as string;
    await h.run({ batchSize: 2 }, failingWith(131026, phone));
    expect(h.statuses('b1')).toEqual({ failed: 1, sent: 1 });
    expect(h.row('broadcasts', 'b1').status).toBe('sent');
  });

  it('a message held for quality counts as sent, with a note', async () => {
    const h = new Harness(merge(account(A), audience(1), { broadcasts: [broadcast()] }));
    const held = vi.fn(async () => ({
      messageId: 'wamid-held',
      messageStatus: 'held_for_quality_assessment',
    })) as unknown as typeof sendTemplateMessage;
    await h.run({}, held);
    const r = h.row('broadcast_recipients', 'r-x-00000');
    expect(r.status).toBe('sent');
    expect(r.whatsapp_message_id).toBe('wamid-held');
    expect(String(r.error_message)).toMatch(/retuvo/);
  });
});

describe('opt-outs', () => {
  it('nobody on the do_not_call list is messaged, even if added after scheduling', async () => {
    const base = audience(3);
    const phone = base.contacts[1].phone as string;
    const h = new Harness(
      merge(account(A), base, {
        broadcasts: [broadcast()],
        do_not_call: [{ id: 'd1', account_id: A, phone_normalized: phone }],
      }),
    );
    await h.run();
    expect(h.calls.map((c) => c.to)).not.toContain(phone);
    expect(h.calls).toHaveLength(2);
    expect(h.row('broadcast_recipients', 'r-x-00001').status).toBe('failed');
    expect(String(h.row('broadcast_recipients', 'r-x-00001').error_message)).toMatch(/no recibir/);
  });

  it("another account's list does not apply", async () => {
    const base = audience(1);
    const h = new Harness(
      merge(account(A), base, {
        broadcasts: [broadcast()],
        do_not_call: [{ id: 'd1', account_id: B, phone_normalized: base.contacts[0].phone as string }],
      }),
    );
    await h.run();
    expect(h.calls).toHaveLength(1);
  });

  it('if the list cannot be read, nothing is sent', async () => {
    const h = new Harness(merge(account(A), audience(2), { broadcasts: [broadcast()] }));
    const client = h.db.asClient();
    const realFrom = client.from.bind(client);
    client.from = ((table: string) => {
      if (table !== 'do_not_call') return realFrom(table);
      throw new Error('db down');
    }) as typeof client.from;
    const summary = await h.run();
    expect(h.calls).toHaveLength(0);
    expect(summary.outcomes[0].result).toBe('error');
    expect(h.statuses('b1')).toEqual({ pending: 2 });
  });
});
