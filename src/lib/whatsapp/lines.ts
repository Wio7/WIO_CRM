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

/** Línea por id, solo si pertenece a la cuenta. */
export async function getLineById(
  db: SupabaseClient,
  accountId: string,
  lineId: string,
): Promise<WhatsAppLine | null> {
  const { data } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('id', lineId)
    .eq('account_id', accountId)
    .maybeSingle();
  return (data as WhatsAppLine | null) ?? null;
}

/**
 * Línea por la que sale un envío: la de la conversación; si no hay
 * conversación, la indicada en `lineId`; si tampoco, la principal.
 * Una conversación cuya línea ya no existe cae a la principal.
 */
export async function resolveSendLine(
  db: SupabaseClient,
  accountId: string,
  opts: { conversationId?: string | null; lineId?: string | null } = {},
): Promise<WhatsAppLine | null> {
  if (opts.conversationId) {
    const line = await getLineForConversation(db, opts.conversationId);
    if (line && line.account_id === accountId) return line;
    return getPrimaryLine(db, accountId);
  }
  if (opts.lineId) return getLineById(db, accountId, opts.lineId);
  return getPrimaryLine(db, accountId);
}

/**
 * Hilo del contacto en una línea (uno por contacto Y línea), creándolo con
 * `line_id` y `area` de la línea si no existe. Los hilos antiguos con
 * line_id NULL solo los reutiliza la línea principal. Lanza si la consulta
 * o la creación fallan de verdad.
 */
export async function findOrCreateLineConversation(
  db: SupabaseClient,
  args: { accountId: string; userId: string; contactId: string; line: WhatsAppLine },
): Promise<{ id: string; created: boolean }> {
  const { accountId, userId, contactId, line } = args;
  let lookup = db
    .from('conversations')
    .select('id, line_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId);
  lookup = line.is_primary
    ? lookup.or(`line_id.eq.${line.id},line_id.is.null`)
    : lookup.eq('line_id', line.id);
  const { data: existing, error: findError } = await lookup
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (findError) throw new Error(`conversation lookup failed: ${findError.message}`);
  if (existing) return { id: existing.id as string, created: false };

  const { data: created, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      line_id: line.id,
      area: line.area,
    })
    .select('id')
    .single();
  if (createError || !created) {
    throw new Error(`conversation create failed: ${createError?.message ?? 'no row'}`);
  }
  return { id: created.id as string, created: true };
}
