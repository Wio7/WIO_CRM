// ============================================================
// Web Push to advisors' phones (Golden App).
//
// When a customer writes, the advisor who owns the conversation gets a
// notification on every device they enabled; an unassigned conversation
// notifies the account's admins/owners instead. Subscriptions live in
// `push_subscriptions` (migration 039).
//
// Needs VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (+ VAPID_SUBJECT). Without
// them every call is a silent no-op, so deployments that don't use the
// Golden App are unaffected.
// ============================================================

import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';

let configured: boolean | null = null;

function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    configured = false;
    return false;
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    publicKey,
    privateKey
  );
  configured = true;
  return true;
}

export interface ConversationPush {
  accountId: string;
  conversationId: string;
  assignedAgentId: string | null;
  title: string;
  body: string;
}

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Notify whoever is responsible for a conversation. Never throws for a
 * delivery problem; expired subscriptions (404/410) are pruned.
 */
export async function notifyConversation(
  db: SupabaseClient,
  push: ConversationPush
): Promise<void> {
  if (!ensureConfigured()) return;

  let recipients: string[];
  if (push.assignedAgentId) {
    recipients = [push.assignedAgentId];
  } else {
    const { data } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', push.accountId)
      .in('account_role', ['owner', 'admin']);
    recipients = (data ?? []).map((p) => p.user_id as string);
  }
  if (recipients.length === 0) return;

  const { data: subscriptions } = await db
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .in('user_id', recipients);
  if (!subscriptions?.length) return;

  const payload = JSON.stringify({
    title: truncate(push.title, 60),
    body: truncate(push.body, 140),
    // The Golden App routes with the hash; the service worker resolves
    // this against its own origin.
    url: `/#/mensajes/${push.conversationId}`,
    tag: `conv-${push.conversationId}`,
  });

  await Promise.all(
    subscriptions.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 3600, urgency: 'high' }
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.from('push_subscriptions').delete().eq('id', s.id);
        } else {
          console.error('[push] send failed:', status, (err as Error).message);
        }
      }
    })
  );
}

/**
 * Avisar al CLIENTE en su celular (Golden App, migración 048).
 *
 * El otro lado de `notifyConversation`: cuando el asesor responde, al
 * cliente le suena el teléfono aunque tenga la app cerrada. Sin esto, el
 * chat de la app obliga a que el cliente se acuerde de volver a mirar, y
 * un canal al que hay que volver a mirar no es un canal.
 *
 * El aviso abre el chat, no la bandeja: para el cliente sólo existe una
 * conversación, la suya.
 *
 * Nunca lanza. Una suscripción vencida (404/410) se borra.
 */
export async function notifyClient(
  db: SupabaseClient,
  push: { contactId: string; title: string; body: string }
): Promise<void> {
  if (!ensureConfigured()) return;

  const { data: subscriptions } = await db
    .from('client_push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('contact_id', push.contactId);
  if (!subscriptions?.length) return;

  const payload = JSON.stringify({
    title: truncate(push.title, 60),
    body: truncate(push.body, 140),
    url: '/#/',
    tag: `cliente-${push.contactId}`,
  });

  await Promise.all(
    subscriptions.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 3600, urgency: 'high' }
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.from('client_push_subscriptions').delete().eq('id', s.id);
        } else {
          console.error('[push] client send failed:', status, (err as Error).message);
        }
      }
    })
  );
}
