// ============================================================
// Meta Lead Ads config access (migration 036).
//
// One config per account, resolved by the unguessable `webhook_token`
// embedded in the account's webhook URL. Secrets (app_secret,
// page_access_token) are AES-256-GCM encrypted at rest with the same
// scheme WhatsApp uses (src/lib/whatsapp/encryption.ts); this module is
// the single place that decrypts them for the webhook.
// ============================================================

import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';

export interface MetaLeadsConfigRow {
  account_id: string;
  webhook_token: string;
  app_secret: string | null;
  verify_token: string | null;
  page_access_token: string | null;
  page_id: string | null;
  is_active: boolean;
}

/** Fetch the active config for a webhook token (service-role client). */
export async function getConfigByToken(
  db: SupabaseClient,
  token: string
): Promise<MetaLeadsConfigRow | null> {
  const { data, error } = await db
    .from('meta_leads_config')
    .select(
      'account_id, webhook_token, app_secret, verify_token, page_access_token, page_id, is_active'
    )
    .eq('webhook_token', token)
    .maybeSingle();
  if (error || !data) return null;
  return data as MetaLeadsConfigRow;
}

/** Decrypt the stored App Secret, or null if unset / undecryptable. */
export function decryptAppSecret(config: MetaLeadsConfigRow): string | null {
  if (!config.app_secret) return null;
  try {
    return decrypt(config.app_secret);
  } catch (err) {
    console.error('[meta-leads] app_secret decryption failed:', err);
    return null;
  }
}

/** Decrypt the stored Page Access Token, or null if unset / undecryptable. */
export function decryptPageToken(config: MetaLeadsConfigRow): string | null {
  if (!config.page_access_token) return null;
  try {
    return decrypt(config.page_access_token);
  } catch (err) {
    console.error('[meta-leads] page_access_token decryption failed:', err);
    return null;
  }
}

/**
 * Verify the HMAC-SHA256 signature Meta attaches to webhook POSTs, using
 * THIS account's App Secret (not a global env var — each account brings
 * its own Meta App). Meta sends `x-hub-signature-256: sha256=<hex>` over
 * the raw request body. Mirrors src/lib/whatsapp/webhook-signature.ts but
 * takes the secret as an argument. Fails closed on any missing input.
 */
export function verifySignatureWithSecret(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string | null
): boolean {
  if (!appSecret) return false;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
