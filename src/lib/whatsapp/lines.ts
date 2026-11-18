// Ayudante de líneas de WhatsApp: `whatsapp_config` es una tabla de líneas
// (varias por cuenta, ver migración 103). Las filas se devuelven tal cual
// están guardadas: `access_token` sigue CIFRADO; quien lo use debe llamar a
// `decrypt` de '@/lib/whatsapp/encryption' (como send-message.ts).
import type { SupabaseClient } from '@supabase/supabase-js';

export type WhatsAppLine = {
  id: string;
  account_id: string;
  phone_number_id: string;
  waba_id: string | null;
  line_name: string;
  area: string | null;
  logo_url: string | null;
  is_primary: boolean;
  status: string;
  access_token: string;
  user_id: string;
};

/** Todas las líneas de la cuenta, ordenadas por sort_order. */
export async function listLines(
  db: SupabaseClient,
  accountId: string,
): Promise<WhatsAppLine[]> {
  const { data } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .order('sort_order', { ascending: true });
  return (data as WhatsAppLine[] | null) ?? [];
}

/** Línea principal de la cuenta (si ninguna está marcada, la de menor sort_order). */
export async function getPrimaryLine(
  db: SupabaseClient,
  accountId: string,
): Promise<WhatsAppLine | null> {
  const { data } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .order('is_primary', { ascending: false })
    .order('sort_order', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as WhatsAppLine | null) ?? null;
}

/** Línea de la conversación; si line_id es NULL, la principal de la cuenta. */
export async function getLineForConversation(
  db: SupabaseClient,
  conversationId: string,
): Promise<WhatsAppLine | null> {
  const { data: conv } = await db
    .from('conversations')
    .select('account_id, line_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conv) return null;
  const { account_id, line_id } = conv as { account_id: string; line_id: string | null };
  if (!line_id) return getPrimaryLine(db, account_id);
  const { data } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('id', line_id)
    .maybeSingle();
  return (data as WhatsAppLine | null) ?? null;
}

/** Línea por phone_number_id (único globalmente, migración 013). */
export async function getLineByPhoneNumberId(
  db: SupabaseClient,
  phoneNumberId: string,
): Promise<WhatsAppLine | null> {
  const { data } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle();
  return (data as WhatsAppLine | null) ?? null;
}
