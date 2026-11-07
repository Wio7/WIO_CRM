import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// decrypt is identity in tests so we don't depend on real ciphertext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}))

import { llaveDeUso, loadAiConfig } from './config'

function dbReturning(row: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  }
  return chain as unknown as SupabaseClient
}

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  embeddings_api_key: null,
}

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(dbReturning(ROW), 'acct')).toBeNull()
  })

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    })
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('openai')
    expect(config!.apiKey).toBe('plain:enc-key')
  })

  it('returns null when there is no row', async () => {
    expect(
      await loadAiConfig(dbReturning(null), 'acct', { requireActive: false }),
    ).toBeNull()
  })
})

describe('llaveDeUso con variable propia de la cuenta', () => {
  it('lee la variable OPENAI_API_KEY_<CUENTA> del servidor', () => {
    vi.stubEnv('OPENAI_API_KEY_BROKER_HOME', ' sk-broker ')
    expect(llaveDeUso('env:OPENAI_API_KEY_BROKER_HOME', 'openai')).toBe('sk-broker')
    vi.unstubAllEnvs()
  })

  it('sin la variable puesta queda vacía (la IA no se enciende)', () => {
    expect(llaveDeUso('env:OPENAI_API_KEY_NO_EXISTE', 'openai')).toBe('')
  })

  it('no deja leer otros secretos del servidor', () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'secreto')
    expect(llaveDeUso('env:SUPABASE_SERVICE_ROLE_KEY', 'openai')).toBe('plain:env:SUPABASE_SERVICE_ROLE_KEY')
    vi.unstubAllEnvs()
  })
})
