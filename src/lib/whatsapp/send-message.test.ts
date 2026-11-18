import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

// A db that explodes if touched — these tests cover the param
// validation that MUST short-circuit before any query runs.
function noDb(): SupabaseClient {
  return {
    from() {
      throw new Error('db should not be queried for invalid params');
    },
  } as unknown as SupabaseClient;
}

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation(noDb(), 'acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation(noDb(), 'acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the stub throwing.
    const spy = vi.fn(() => {
      throw new Error('reached DB');
    });
    const db = { from: spy } as unknown as SupabaseClient;
    await expect(
      sendMessageToConversation(db, 'acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('reached DB');
    expect(spy).toHaveBeenCalledWith('conversations');
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});

// ------------------------------------------------------------
// Varias líneas por cuenta: la respuesta sale por la línea del hilo.
// ------------------------------------------------------------
const { sendTextMessage } = vi.hoisted(() => ({
  sendTextMessage: vi.fn(async (..._args: unknown[]) => ({ messageId: 'wamid-1' })),
}));
vi.mock('@/lib/whatsapp/meta-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTextMessage,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((v: string) => `plain:${v}`),
  encrypt: vi.fn((v: string) => v),
  isLegacyFormat: vi.fn(() => false),
}));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    const b: Record<string, unknown> = {};
    for (const m of ['update', 'eq']) b[m] = () => b;
    b.then = (res: (v: unknown) => unknown) => res({ data: null, error: null });
    return { from: () => b };
  },
}));
vi.mock('@/lib/push/send', () => ({ notifyClient: vi.fn(async () => undefined) }));

const LINE_A = {
  id: 'line-A', account_id: 'acct-1', phone_number_id: 'PNID-A', access_token: 'tok-A',
  is_primary: true, area: null as string | null, user_id: 'u1',
};
const LINE_B = {
  id: 'line-B', account_id: 'acct-1', phone_number_id: 'PNID-B', access_token: 'tok-B',
  is_primary: false, area: 'posventa', user_id: 'u1',
};

function dbWithLines(
  lines: (typeof LINE_A)[],
  conversationLineId: string | null,
  lineReadError: { message: string } | null = null,
): SupabaseClient {
  return {
    from(table: string) {
      let eqId: string | null = null;
      const b: Record<string, unknown> = {};
      const chain = () => b;
      for (const m of ['select', 'order', 'limit', 'update', 'insert']) b[m] = vi.fn(chain);
      b.eq = vi.fn((col: string, val: string) => {
        if (col === 'id') eqId = val;
        return b;
      });
      const result = () => {
        if (table === 'conversations') {
          return {
            data: {
              id: 'cv-1', account_id: 'acct-1', line_id: conversationLineId,
              contact: { id: 'ct-1', phone: '+15551234567' },
            },
            error: null,
          };
        }
        if (table === 'whatsapp_config') {
          if (lineReadError && eqId) return { data: null, error: lineReadError };
          const row = eqId
            ? lines.find((l) => l.id === eqId)
            : [...lines].sort((x, y) => Number(y.is_primary) - Number(x.is_primary))[0];
          return { data: row ?? null, error: null };
        }
        if (table === 'messages') return { data: { id: 'msg-1' }, error: null };
        return { data: null, error: null };
      };
      b.single = () => Promise.resolve(result());
      b.maybeSingle = () => Promise.resolve(result());
      b.then = (res: (v: unknown) => unknown) => res(result());
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('sendMessageToConversation — línea de la conversación', () => {
  const params = { conversationId: 'cv-1', messageType: 'text', contentText: 'hola' };

  it('un hilo de la línea B responde con el phone_number_id y el token de B', async () => {
    sendTextMessage.mockClear();
    await sendMessageToConversation(dbWithLines([LINE_A, LINE_B], 'line-B'), 'acct-1', params);
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: 'PNID-B', accessToken: 'plain:tok-B' }),
    );
  });

  it('un hilo de la línea A responde con los de A', async () => {
    sendTextMessage.mockClear();
    await sendMessageToConversation(dbWithLines([LINE_A, LINE_B], 'line-A'), 'acct-1', params);
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: 'PNID-A', accessToken: 'plain:tok-A' }),
    );
  });

  it('un hilo antiguo sin line_id sale por la principal', async () => {
    sendTextMessage.mockClear();
    await sendMessageToConversation(dbWithLines([LINE_B, LINE_A], null), 'acct-1', params);
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: 'PNID-A' }),
    );
  });

  it('una cuenta con una sola línea sigue igual', async () => {
    sendTextMessage.mockClear();
    await sendMessageToConversation(dbWithLines([LINE_A], null), 'acct-1', params);
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: 'PNID-A', accessToken: 'plain:tok-A' }),
    );
  });

  it('sin ninguna línea conectada devuelve el mismo error de siempre', async () => {
    await expect(
      sendMessageToConversation(dbWithLines([], null), 'acct-1', params),
    ).rejects.toMatchObject({ code: 'whatsapp_not_configured', status: 400 });
  });
});

describe('sendMessageToConversation — nunca cae a la principal si falla la línea del hilo', () => {
  const params = { conversationId: 'cv-1', messageType: 'text', contentText: 'hola' };

  it('hilo con line_id y error al leer la línea: no llama a Graph y falla con line_unavailable', async () => {
    sendTextMessage.mockClear();
    await expect(
      sendMessageToConversation(
        dbWithLines([LINE_A, LINE_B], 'line-B', { message: 'timeout' }),
        'acct-1',
        params,
      ),
    ).rejects.toMatchObject({ code: 'line_unavailable', status: 503 });
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('hilo con line_id cuya línea ya no existe: tampoco sale por la principal', async () => {
    sendTextMessage.mockClear();
    await expect(
      sendMessageToConversation(dbWithLines([LINE_A], 'line-B'), 'acct-1', params),
    ).rejects.toMatchObject({ code: 'line_unavailable' });
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it('hilo con line_id NULL sigue usando la principal', async () => {
    sendTextMessage.mockClear();
    await sendMessageToConversation(dbWithLines([LINE_B, LINE_A], null), 'acct-1', params);
    expect(sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: 'PNID-A' }));
  });
});
