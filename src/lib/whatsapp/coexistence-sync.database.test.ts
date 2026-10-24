import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('079: reintentos, aislamiento, orden, nombres editados y ausencia de efectos indirectos', async () => {
  const db = new PGlite()
  const account = '00000000-0000-0000-0000-000000000001'
  const contact = '00000000-0000-0000-0000-000000000002'
  const other = '00000000-0000-0000-0000-000000000003'
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE contacts(id uuid PRIMARY KEY, account_id uuid, name text, phone text);
      CREATE TABLE conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, user_id uuid,
        contact_id uuid, assigned_agent_id uuid, created_at timestamptz DEFAULT now(), last_message_at timestamptz,
        last_message_text text, unread_count integer DEFAULT 0);
      CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, sender_type text,
        sender_id uuid, content_type text, content_text text, media_url text, interactive_reply_id text,
        message_id text, status text, created_at timestamptz);
      CREATE TABLE effects(kind text);
      CREATE FUNCTION assign_new_conversation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO effects VALUES ('assign'); RETURN NEW; END $$;
      CREATE FUNCTION notify_conversation_assigned() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO effects VALUES ('notify'); RETURN NEW; END $$;
      CREATE FUNCTION reiniciar_seguimiento() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO effects VALUES ('followup'); RETURN NEW; END $$;
      INSERT INTO contacts VALUES ('${contact}', '${account}', '51922222222', '51922222222');
    `)
    const migration = readFileSync('supabase/migrations/079_whatsapp_coexistence_sync.sql', 'utf8')
    await db.exec(migration)
    await db.exec(migration)
    const resolve = () => db.query<{ id: string }>('SELECT (coexistence_conversation($1,$1,$2)).id', [account, contact])
    const conv = (await resolve()).rows[0].id
    expect((await resolve()).rows[0].id).toBe(conv)
    const insert = (rows: object[], tenant = account, conversation = conv) => db.query('SELECT coexistence_insert_messages($1,$2,$3)', [tenant, conversation, JSON.stringify(rows)])
    const row = { message_id: 'wamid.1', sender_type: 'customer', content_type: 'text', content_text: 'Antes', status: 'delivered', created_at: '2026-01-01T00:00:00Z', source: 'phone_history' }
    await insert([row, row])
    await insert([row])
    expect((await db.query('SELECT count(*)::int AS n FROM messages')).rows).toEqual([{ n: 1 }])
    expect((await db.query('SELECT * FROM effects')).rows).toEqual([])
    await insert([{ ...row, message_id: 'wamid.2', content_text: 'Después', created_at: '2026-02-01T00:00:00Z' }])
    await insert([{ ...row, message_id: 'wamid.3' }])
    expect((await db.query('SELECT last_message_text, unread_count FROM conversations')).rows).toEqual([{ last_message_text: 'Después', unread_count: 0 }])
    await expect(insert([row], other)).rejects.toThrow('fuera de la cuenta')
    await db.query('INSERT INTO conversations(id, account_id) VALUES ($1, $1)', [other])
    await insert([row], other, other)
    expect((await db.query('SELECT count(*)::int AS n FROM messages WHERE message_id = $1', ['wamid.1'])).rows).toEqual([{ n: 2 }])
    // El reparto y los avisos ordinarios siguen habilitados.
    expect((await db.query('SELECT kind FROM effects ORDER BY kind')).rows).toEqual([{ kind: 'assign' }, { kind: 'notify' }])
    const rename = (name: string) => db.query('SELECT coexistence_contact_name($1,$2,$3)', [account, contact, name])
    await rename('Perfil WhatsApp')
    await rename('Perfil actualizado')
    expect((await db.query('SELECT name FROM contacts')).rows).toEqual([{ name: 'Perfil actualizado' }])
    await db.query('UPDATE contacts SET name = $1 WHERE id = $2', ['Nombre CRM', contact])
    await rename('No sobrescribir')
    expect((await db.query('SELECT name, whatsapp_profile_name FROM contacts')).rows).toEqual([{ name: 'Nombre CRM', whatsapp_profile_name: null }])
    await db.exec('SET ROLE authenticated')
    await expect(rename('Prohibido')).rejects.toThrow('permission denied')
  } finally { await db.close() }
}, 30000)
