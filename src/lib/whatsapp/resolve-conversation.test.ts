import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveConversationByPhone } from './resolve-conversation';
import { SendMessageError } from './send-message';

// ------------------------------------------------------------
// Chainable Supabase stub, scripted per table. Terminal methods
// (like/maybeSingle/single) resolve to configured data; the builder
// itself is thenable so an awaited `update().eq()` resolves cleanly.
// ------------------------------------------------------------
type ContactRow = { id: string; phone: string; name?: string | null };

interface Script {
  config?: {
    user_id: string;
    id?: string;
    area?: string | null;
    is_primary?: boolean;
  } | null; // whatsapp_config.maybeSingle
  /** Líneas por id (whatsapp_config con .eq('id')). */
  lineById?: Record<string, { id: string; account_id: string; area: string | null; is_primary: boolean; user_id: string }>;
  /** Error de la consulta de conversaciones (no es "sin fila"). */
  conversationLookupError?: { message: string } | null;
  /** Registra los inserts y los filtros de la consulta de conversaciones. */
  log?: { inserts: Record<string, unknown>[]; filters: unknown[][] };
  contactCandidates?: ContactRow[]; // contacts .like (same every call)
  /** Per-call `.like` results — overrides contactCandidates. Lets a
   *  test simulate "miss, then hit" for the unique-race path. */
  contactCandidatesByCall?: ContactRow[][];
  insertedContactId?: string; // contacts insert -> single
  insertContactError?: { code?: string } | null;
  existingConversation?: { id: string } | null; // conversations select.maybeSingle
  insertedConversationId?: string; // conversations insert -> single
}

function makeDb(script: Script): SupabaseClient {
  let table = '';
  let mode: 'select' | 'insert' | 'update' = 'select';
  let eqId: string | null = null;
  let likeCalls = 0;

  const builder: Record<string, unknown> = {
    select: () => builder,
    insert: (payload?: Record<string, unknown>) => {
      mode = 'insert';
      if (table === 'conversations' && payload) script.log?.inserts.push(payload);
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    or: (...args: unknown[]) => {
      if (table === 'conversations') script.log?.filters.push(['or', ...args]);
      return builder;
    },
    update: () => {
      mode = 'update';
      return builder;
    },
    eq: (...args: unknown[]) => {
      if (table === 'whatsapp_config' && args[0] === 'id') eqId = args[1] as string;
      if (table === 'conversations') script.log?.filters.push(['eq', ...args]);
      return builder;
    },
    like: () => {
      const data = script.contactCandidatesByCall
        ? (script.contactCandidatesByCall[likeCalls] ?? [])
        : (script.contactCandidates ?? []);
      likeCalls++;
      return Promise.resolve({ data, error: null });
    },
    maybeSingle: () => {
      if (table === 'whatsapp_config') {
        if (eqId) {
          return Promise.resolve({ data: script.lineById?.[eqId] ?? null, error: null });
        }
        return Promise.resolve({
          data: script.config
            ? { id: 'line-1', area: null, is_primary: true, ...script.config }
            : null,
          error: null,
        });
      }
      if (table === 'conversations' && mode === 'select')
        return Promise.resolve({
          data: script.existingConversation ?? null,
          error: script.conversationLookupError ?? null,
        });
      return Promise.resolve({ data: null, error: null });
    },
    single: () => {
      if (table === 'contacts' && mode === 'insert') {
        if (script.insertContactError)
          return Promise.resolve({
            data: null,
            error: script.insertContactError,
          });
        return Promise.resolve({
          data: { id: script.insertedContactId },
          error: null,
        });
      }
      if (table === 'conversations' && mode === 'insert')
        return Promise.resolve({
          data: { id: script.insertedConversationId },
          error: null,
        });
      return Promise.resolve({ data: null, error: null });
    },
    // Thenable: `await db.from().update().eq()` lands here.
    then: (resolve: (v: { data: null; error: null }) => void) =>
      resolve({ data: null, error: null }),
  };

  return {
    from: (t: string) => {
      table = t;
      mode = 'select';
      eqId = null;
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe('resolveConversationByPhone', () => {
  it('rejects an invalid phone before any DB call', async () => {
    const db = {
      from() {
        throw new Error('should not query');
      },
    } as unknown as SupabaseClient;
    await expect(
      resolveConversationByPhone(db, 'acct', 'not-a-phone')
    ).rejects.toBeInstanceOf(SendMessageError);
  });

  it('fails with whatsapp_not_configured when no config owner exists', async () => {
    const db = makeDb({ config: null });
    await resolveConversationByPhone(db, 'acct', '+14155550123').catch(
      (e: SendMessageError) => {
        expect(e.code).toBe('whatsapp_not_configured');
        expect(e.status).toBe(400);
      }
    );
    await expect(
      resolveConversationByPhone(db, 'acct', '+14155550123')
    ).rejects.toBeInstanceOf(SendMessageError);
  });

  it('returns the existing contact + conversation without creating', async () => {
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidates: [{ id: 'c1', phone: '14155550123' }],
      existingConversation: { id: 'cv1' },
    });
    const res = await resolveConversationByPhone(
      db,
      'acct',
      '+1 (415) 555-0123'
    );
    expect(res).toEqual({
      conversationId: 'cv1',
      contactId: 'c1',
      contactCreated: false,
    });
  });

  it('creates contact + conversation when none exist', async () => {
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidates: [],
      insertedContactId: 'c2',
      existingConversation: null,
      insertedConversationId: 'cv2',
    });
    const res = await resolveConversationByPhone(
      db,
      'acct',
      '+14155550199',
      'Jane'
    );
    expect(res).toEqual({
      conversationId: 'cv2',
      contactId: 'c2',
      contactCreated: true,
    });
  });

  it('re-resolves an existing contact when the insert loses a unique race', async () => {
    // First lookup misses (→ we attempt an insert), the insert hits a
    // 23505 unique violation, and the post-race re-lookup now returns
    // the row a concurrent writer created.
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidatesByCall: [[], [{ id: 'c-raced', phone: '14155550123' }]],
      insertContactError: { code: '23505' },
      existingConversation: { id: 'cv-raced' },
    });
    const res = await resolveConversationByPhone(db, 'acct', '+14155550123');
    expect(res.contactId).toBe('c-raced');
    expect(res.contactCreated).toBe(false);
    expect(res.conversationId).toBe('cv-raced');
  });
});

describe('resolveConversationByPhone — líneas', () => {
  const newLog = () => ({ inserts: [] as Record<string, unknown>[], filters: [] as unknown[][] });
  const lineB = {
    'line-B': { id: 'line-B', account_id: 'acct', area: 'postventa', is_primary: false, user_id: 'owner-1' },
  };

  it('un contacto con hilos en dos líneas no crea un tercero: busca por línea', async () => {
    const log = newLog();
    const db = makeDb({
      config: { user_id: 'owner-1', id: 'line-A', is_primary: true },
      lineById: lineB,
      contactCandidates: [{ id: 'c1', phone: '14155550123' }],
      existingConversation: { id: 'cv-B' },
      log,
    });
    const res = await resolveConversationByPhone(db, 'acct', '+14155550123', null, 'line-B');
    expect(res.conversationId).toBe('cv-B');
    expect(log.inserts).toHaveLength(0);
    // La línea B no principal busca solo su línea (sin hilos antiguos NULL).
    expect(log.filters).toContainEqual(['eq', 'line_id', 'line-B']);
    expect(log.filters.some((f) => f[0] === 'or')).toBe(false);
  });

  it('la línea principal también reutiliza hilos antiguos con line_id NULL', async () => {
    const log = newLog();
    const db = makeDb({
      config: { user_id: 'owner-1', id: 'line-A', is_primary: true },
      contactCandidates: [{ id: 'c1', phone: '14155550123' }],
      existingConversation: { id: 'cv-old' },
      log,
    });
    await resolveConversationByPhone(db, 'acct', '+14155550123');
    expect(log.filters).toContainEqual(['or', 'line_id.eq.line-A,line_id.is.null']);
  });

  it('un hilo nuevo se crea con line_id y area de la línea', async () => {
    const log = newLog();
    const db = makeDb({
      config: { user_id: 'owner-1', id: 'line-A', is_primary: true },
      lineById: lineB,
      contactCandidates: [{ id: 'c1', phone: '14155550123' }],
      existingConversation: null,
      insertedConversationId: 'cv-new',
      log,
    });
    const res = await resolveConversationByPhone(db, 'acct', '+14155550123', null, 'line-B');
    expect(res.conversationId).toBe('cv-new');
    expect(log.inserts).toEqual([
      expect.objectContaining({ contact_id: 'c1', line_id: 'line-B', area: 'postventa' }),
    ]);
  });

  it('una línea que no es de la cuenta falla como whatsapp_not_configured', async () => {
    const db = makeDb({ config: { user_id: 'owner-1' }, lineById: {} });
    await expect(
      resolveConversationByPhone(db, 'acct', '+14155550123', null, 'line-X')
    ).rejects.toMatchObject({ code: 'whatsapp_not_configured' });
  });

  it('un error real al buscar el hilo no se toma por "sin fila": falla sin crear', async () => {
    const log = newLog();
    const db = makeDb({
      config: { user_id: 'owner-1' },
      contactCandidates: [{ id: 'c1', phone: '14155550123' }],
      conversationLookupError: { message: 'boom' },
      log,
    });
    await expect(
      resolveConversationByPhone(db, 'acct', '+14155550123')
    ).rejects.toMatchObject({ code: 'db_error' });
    expect(log.inserts).toHaveLength(0);
  });
});
