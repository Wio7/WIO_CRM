/**
 * Datos y cliente falso para probar rutas de plantillas y difusiones con
 * varias líneas de WhatsApp. Solo para pruebas (sin red).
 */
import { FakeDb, type Row } from '@/lib/test-support/fake-db';

export const ACC = 'acc-1';
export const OTHER_ACC = 'acc-2';

export function line(overrides: Row = {}): Row {
  return {
    id: 'line-a',
    account_id: ACC,
    user_id: 'user-1',
    line_name: 'Principal',
    phone_number_id: 'pn-a',
    waba_id: 'waba-a',
    access_token: 'enc-a',
    is_primary: true,
    sort_order: 0,
    disconnected_at: null,
    ...overrides,
  };
}

export const LINE_A = line();
export const LINE_B = line({
  id: 'line-b',
  line_name: 'Posventa',
  phone_number_id: 'pn-b',
  waba_id: 'waba-b',
  access_token: 'enc-b',
  is_primary: false,
  sort_order: 1,
});
export const FOREIGN_LINE = line({
  id: 'line-x',
  account_id: OTHER_ACC,
  phone_number_id: 'pn-x',
  waba_id: 'waba-x',
  access_token: 'enc-x',
});

/** Cliente de Supabase de una petición autenticada como `user-1` de ACC. */
export function routeClient(db: FakeDb) {
  if (db.table('profiles').length === 0) {
    db.table('profiles').push({ user_id: 'user-1', account_id: ACC });
  }
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    },
    from(table: string) {
      const q = db.from(table) as unknown as Record<string, unknown>;
      if (table === 'message_templates') {
        // FakeDb no implementa upsert: lo guardamos como inserción.
        q.upsert = (row: Row) => {
          const saved = { id: 'tpl-new', ...row };
          db.table('message_templates').push(saved);
          return { select: () => ({ single: async () => ({ data: saved, error: null }) }) };
        };
      }
      return q;
    },
  };
}
