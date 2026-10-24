import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { expect, it } from 'vitest'

it('077 es idempotente y mantiene filas manuales y lecturas existentes', async () => {
  const db = new PGlite()
  try {
    await db.exec("CREATE TABLE whatsapp_config (account_id TEXT PRIMARY KEY, phone_number_id TEXT); INSERT INTO whatsapp_config VALUES ('old', '123');")
    const sql = readFileSync('supabase/migrations/077_whatsapp_embedded_signup.sql', 'utf8')
    await db.exec(sql)
    await db.exec(sql)
    expect((await db.query('SELECT account_id, phone_number_id, connection_type FROM whatsapp_config')).rows)
      .toEqual([{ account_id: 'old', phone_number_id: '123', connection_type: 'manual' }])
    await expect(db.exec("INSERT INTO whatsapp_config (account_id, connection_type) VALUES ('bad', 'invalid')")).rejects.toThrow()
    await expect(db.exec("INSERT INTO whatsapp_config (account_id, connection_type) VALUES ('null', NULL)")).rejects.toThrow()
  } finally { await db.close() }
}, 30000) // PGlite tarda en arrancar cuando corre toda la suite en paralelo.
