import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: (...a: unknown[]) => sendNotification(...a),
  },
}));

vi.stubEnv('VAPID_PUBLIC_KEY', 'pub');
vi.stubEnv('VAPID_PRIVATE_KEY', 'priv');

import { notifyUsers } from './send';

function fakeDb(subs: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>) {
  const inFn = vi.fn().mockResolvedValue({ data: subs });
  const select = vi.fn().mockReturnValue({ in: inFn });
  const eq = vi.fn().mockResolvedValue({});
  const del = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select, delete: del });
  return { db: { from } as never, from, inFn, eq };
}

const push = { title: 'T', body: 'B', url: 'https://x.test/u', tag: 't' };

describe('notifyUsers', () => {
  beforeEach(() => sendNotification.mockReset());

  it('con lista vacía devuelve 0 sin consultar', async () => {
    const f = fakeDb([]);
    expect(await notifyUsers(f.db, { ...push, userIds: [] })).toBe(0);
    expect(f.from).not.toHaveBeenCalled();
  });

  it('consulta sólo las suscripciones de esos userIds y cuenta los envíos', async () => {
    const f = fakeDb([
      { id: 's1', endpoint: 'e1', p256dh: 'p', auth: 'a' },
      { id: 's2', endpoint: 'e2', p256dh: 'p', auth: 'a' },
    ]);
    sendNotification.mockResolvedValue({});
    expect(await notifyUsers(f.db, { ...push, userIds: ['u1', 'u2'] })).toBe(2);
    expect(f.from).toHaveBeenCalledWith('push_subscriptions');
    expect(f.inFn).toHaveBeenCalledWith('user_id', ['u1', 'u2']);
    expect(JSON.parse(sendNotification.mock.calls[0][1])).toEqual({
      title: 'T',
      body: 'B',
      url: 'https://x.test/u',
      tag: 't',
    });
    expect(sendNotification.mock.calls[0][2]).toEqual({ TTL: 3600, urgency: 'high' });
  });

  it('borra la suscripción vencida (410) y no lanza ante otros errores', async () => {
    const f = fakeDb([
      { id: 's1', endpoint: 'e1', p256dh: 'p', auth: 'a' },
      { id: 's2', endpoint: 'e2', p256dh: 'p', auth: 'a' },
    ]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sendNotification
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }))
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { statusCode: 500 }));
    expect(await notifyUsers(f.db, { ...push, userIds: ['u1'] })).toBe(0);
    expect(f.eq).toHaveBeenCalledTimes(1);
    expect(f.eq).toHaveBeenCalledWith('id', 's1');
  });
});
