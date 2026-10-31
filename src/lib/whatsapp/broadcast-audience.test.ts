import { describe, expect, it } from 'vitest';

import { FakeDb, type Row } from '@/lib/test-support/fake-db';
import type { MessageTemplate } from '@/types';
import {
  cancelScheduledBroadcast,
  createServerBroadcast,
  resolveAudienceContactIds,
  upsertCsvContacts,
} from './broadcast-audience';

const ACCOUNT = 'acc-1';
const OTHER_ACCOUNT = 'acc-2';
const USER = 'user-1';

function contacts(n: number, account = ACCOUNT, offset = 0): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const k = i + offset;
    return {
      id: `c-${account}-${String(k).padStart(5, '0')}`,
      account_id: account,
      phone: `5190${String(k).padStart(7, '0')}`,
      phone_normalized: `5190${String(k).padStart(7, '0')}`,
    };
  });
}

const template = { name: 'promo', language: 'es' } as MessageTemplate;

describe('resolveAudienceContactIds with 1500 people', () => {
  it('"all" reads every page, only from this account', async () => {
    const db = new FakeDb({
      contacts: [...contacts(1500), ...contacts(10, OTHER_ACCOUNT)],
    });
    const ids = await resolveAudienceContactIds(db.asClient(), ACCOUNT, USER, { type: 'all' });
    expect(ids).toHaveLength(1500);
    expect(new Set(ids).size).toBe(1500);
    expect(ids.every((id) => id.includes(ACCOUNT))).toBe(true);
  });

  it('tags: pages contact_tags and chunks the contact lookup', async () => {
    const all = contacts(1500);
    const db = new FakeDb({
      contacts: all,
      contact_tags: all.map((c) => ({ contact_id: c.id, tag_id: 't1' })),
    });
    const ids = await resolveAudienceContactIds(db.asClient(), ACCOUNT, USER, {
      type: 'tags',
      tagIds: ['t1'],
    });
    expect(ids).toHaveLength(1500);
    expect(Math.max(...db.inListSizes())).toBeLessThanOrEqual(100);
  });

  it('exclude tags subtracts people beyond the first 1000 rows', async () => {
    const all = contacts(1500);
    const db = new FakeDb({
      contacts: all,
      contact_tags: all.slice(0, 1200).map((c) => ({ contact_id: c.id, tag_id: 'excluded' })),
    });
    const ids = await resolveAudienceContactIds(db.asClient(), ACCOUNT, USER, {
      type: 'all',
      excludeTagIds: ['excluded'],
    });
    expect(ids).toHaveLength(300);
  });

  it('custom field: pages the values', async () => {
    const all = contacts(1500);
    const db = new FakeDb({
      contacts: all,
      contact_custom_values: all.map((c) => ({
        contact_id: c.id,
        custom_field_id: 'f1',
        value: 'vip',
      })),
    });
    const ids = await resolveAudienceContactIds(db.asClient(), ACCOUNT, USER, {
      type: 'custom_field',
      customField: { fieldId: 'f1', operator: 'is', value: 'vip' },
    });
    expect(ids).toHaveLength(1500);
  });
});

describe('upsertCsvContacts', () => {
  it('matches 700 existing contacts and creates 800, never one huge IN', async () => {
    const existing = contacts(700);
    const db = new FakeDb({ contacts: existing });
    const rows = Array.from({ length: 1500 }, (_, i) => ({
      phone: `5190${String(i).padStart(7, '0')}`,
      name: `P${i}`,
    }));
    const ids = await upsertCsvContacts(db.asClient(), ACCOUNT, USER, rows);

    expect(ids).toHaveLength(1500);
    expect(new Set(ids).size).toBe(1500);
    expect(db.table('contacts')).toHaveLength(1500); // 700 + 800 new
    // Every id for an existing phone is the existing contact's id.
    for (const c of existing) expect(ids).toContain(c.id);
    expect(Math.max(...db.inListSizes())).toBeLessThanOrEqual(300);
    // Lookups and inserts are scoped to the account.
    const lookups = db.log.filter((l) => l.table === 'contacts' && l.op === 'select');
    expect(lookups.every((l) => l.filters.some((f) => f.col === 'account_id' && f.value === ACCOUNT))).toBe(true);
    const inserted = db.table('contacts').slice(700) as Row[];
    expect(inserted.every((c) => c.account_id === ACCOUNT && c.user_id === USER)).toBe(true);
  });

  it('reuses a contact stored with a trunk-prefix variant of the phone', async () => {
    // Stored with a trunk 0 after the country code; the file has the clean number.
    const db = new FakeDb({
      contacts: [
        { id: 'old', account_id: ACCOUNT, phone: '370063949836', phone_normalized: '370063949836' },
      ],
    });
    const ids = await upsertCsvContacts(db.asClient(), ACCOUNT, USER, [{ phone: '37063949836' }]);
    expect(ids).toEqual(['old']);
    expect(db.table('contacts')).toHaveLength(1);
  });

  it("does not match another account's contact", async () => {
    const db = new FakeDb({ contacts: contacts(1, OTHER_ACCOUNT) });
    const phone = String(db.table('contacts')[0].phone);
    const ids = await upsertCsvContacts(db.asClient(), ACCOUNT, USER, [{ phone }]);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(db.table('contacts')[0].id);
    expect(db.table('contacts')).toHaveLength(2);
  });

  it('falls back to row-by-row on a unique violation and finds the winner', async () => {
    const db = new FakeDb({ contacts: [] });
    // Someone created this phone meanwhile.
    db.beforeExec = (q) => {
      if (q.table === 'contacts' && q.op === 'insert' && db.table('contacts').length === 0) {
        db.table('contacts').push({
          id: 'raced',
          account_id: ACCOUNT,
          phone: '51944585122',
          phone_normalized: '51944585122',
        });
      }
    };
    const ids = await upsertCsvContacts(db.asClient(), ACCOUNT, USER, [
      { phone: '51944585122' },
      { phone: '51987654321' },
    ]);
    expect(ids).toHaveLength(2);
    expect(ids).toContain('raced');
  });
});

describe('createServerBroadcast', () => {
  it('saves a draft, 1500 pending recipients, then arms it as scheduled', async () => {
    const db = new FakeDb({ contacts: contacts(1500) });
    const when = new Date('2026-11-05T15:00:00.000Z');
    const progress: number[] = [];
    const id = await createServerBroadcast(
      db.asClient(),
      { accountId: ACCOUNT, userId: USER },
      {
        name: 'Noviembre',
        template,
        audience: { type: 'all' },
        variables: { '1': { type: 'field', value: 'name' } },
        headerMediaUrl: ' https://x.test/a.jpg ',
        scheduledAt: when,
      },
      (p) => progress.push(p),
    );

    const [broadcast] = db.table('broadcasts');
    expect(broadcast).toMatchObject({
      id,
      account_id: ACCOUNT,
      user_id: USER,
      status: 'scheduled',
      scheduled_at: '2026-11-05T15:00:00.000Z',
      total_recipients: 1500,
      template_name: 'promo',
      template_language: 'es',
      template_variables: { '1': { type: 'field', value: 'name' } },
      audience_filter: { type: 'all', dispatch: 'server', headerMediaUrl: 'https://x.test/a.jpg' },
    });
    const recipients = db.table('broadcast_recipients');
    expect(recipients).toHaveLength(1500);
    expect(recipients.every((r) => r.status === 'pending' && r.broadcast_id === id)).toBe(true);
    expect(progress[progress.length - 1]).toBe(100);

    // Safe ordering: born as draft, armed only after the recipients exist.
    const writes = db.log.filter((l) => l.op !== 'select');
    expect((writes[0].payload as Row).status).toBe('draft');
    const armIndex = writes.findIndex(
      (l) => l.op === 'update' && (l.payload as Row).status === 'scheduled',
    );
    const lastRecipientInsert = writes.map((l) => l.table).lastIndexOf('broadcast_recipients');
    expect(armIndex).toBeGreaterThan(lastRecipientInsert);
  });

  it('never arms the broadcast when saving recipients fails', async () => {
    const db = new FakeDb({ contacts: contacts(500) });
    db.failNext('broadcast_recipients', 'insert', { message: 'boom' });
    await expect(
      createServerBroadcast(
        db.asClient(),
        { accountId: ACCOUNT, userId: USER },
        { name: 'x', template, audience: { type: 'all' }, variables: {}, scheduledAt: new Date() },
      ),
    ).rejects.toThrow(/destinatarios/);
    expect(db.table('broadcasts')[0].status).toBe('failed');
  });

  it('refuses an empty audience', async () => {
    const db = new FakeDb();
    await expect(
      createServerBroadcast(
        db.asClient(),
        { accountId: ACCOUNT, userId: USER },
        { name: 'x', template, audience: { type: 'all' }, variables: {}, scheduledAt: new Date() },
      ),
    ).rejects.toThrow(/No hay contactos/);
    expect(db.table('broadcasts')).toHaveLength(0);
  });
});

describe('cancelScheduledBroadcast', () => {
  it('moves scheduled to draft', async () => {
    const db = new FakeDb({ broadcasts: [{ id: 'b1', status: 'scheduled' }] });
    expect(await cancelScheduledBroadcast(db.asClient(), 'b1')).toEqual({ cancelled: true });
    expect(db.table('broadcasts')[0].status).toBe('draft');
  });

  it('does nothing if the dispatcher already claimed it', async () => {
    const db = new FakeDb({ broadcasts: [{ id: 'b1', status: 'sending' }] });
    expect(await cancelScheduledBroadcast(db.asClient(), 'b1')).toEqual({ cancelled: false });
    expect(db.table('broadcasts')[0].status).toBe('sending');
  });
});
