// Ayudante de líneas de WhatsApp: `whatsapp_config` es una tabla de líneas
// (varias por cuenta, ver migración 103). Las filas se devuelven tal cual
// están guardadas: `access_token` sigue CIFRADO; quien lo use debe llamar a
// `decrypt` de '@/lib/whatsapp/encryption' (como send-message.ts).
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * La conversación (o el envío) apunta a una línea concreta y no se pudo
 * leer: error de la base o la fila ya no existe. NUNCA se sustituye por la
 * línea principal, que mandaría el mensaje desde otro número.
 */
export class LineUnavailableError extends Error {
  /** true = fallo de lectura de la base (reintentable); false = línea desconectada o ya no existe. */
  readonly transient: boolean;
  constructor(
    message = 'La línea de WhatsApp de esta conversación no está disponible',
    opts: { transient?: boolean } = {},
  ) {
    super(message);
    this.name = 'LineUnavailableError';
    this.transient = opts.transient ?? false;
  }
}

/** Áreas permitidas en whatsapp_config.area (CHECK de la migración 103). */
export const LINE_AREAS = [
  'marketing', 'legal', 'cobranzas', 'ventas', 'gerencia',
  'contabilidad', 'tecnica', 'promueve', 'administracion', 'posventa',
] as const;

/**
 * Una línea con desconexión suave (disconnected_at no nulo: conserva sus
 * conversaciones pero su token ya no sirve) nunca se usa para enviar. NO se
 * mira `status`: 'disconnected' también lo deja un /register fallido con el
 * token vigente, y esas líneas siguen intentando enviar como siempre.
 */
function usable(line: WhatsAppLine | null): WhatsAppLine | null {
  if (line && line.disconnected_at) {
    throw new LineUnavailableError(
      `La línea "${line.line_name}" está desconectada. Reconéctala para enviar mensajes.`,
    );
  }
  return line;
}

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
  disconnected_at: string | null;
  access_token: string;
  user_id: string;
};

/** Todas las líneas de la cuenta: las en uso primero, luego por sort_order. */
export async function listLines(
  db: SupabaseClient,
  accountId: string,
): Promise<WhatsAppLine[]> {
  const { data } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .order('disconnected_at', { ascending: true, nullsFirst: true })
    .order('sort_order', { ascending: true });
  return (data as WhatsAppLine[] | null) ?? [];
}

/**
 * Línea principal de la cuenta (si ninguna está marcada, la de menor
 * sort_order). Prefiere líneas conectadas sobre las desconectadas. Devuelve
 * la fila tal cual; los envíos pasan por getLineForConversation/resolveSendLine,
 * que rechazan líneas desconectadas.
 */
export async function getPrimaryLine(
  db: SupabaseClient,
  accountId: string,
): Promise<WhatsAppLine | null> {
  const { data } = await readPrimaryLine(db, accountId);
  return (data as WhatsAppLine | null) ?? null;
}

function readPrimaryLine(db: SupabaseClient, accountId: string) {
  return db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .order('disconnected_at', { ascending: true, nullsFirst: true }) // en uso antes que desconectadas
    .order('is_primary', { ascending: false })
    .order('sort_order', { ascending: true })
    .limit(1)
    .maybeSingle();
}

/** Línea de la conversación; si line_id es NULL, la principal de la cuenta. */
export async function getLineForConversation(
  db: SupabaseClient,
  conversationId: string,
): Promise<WhatsAppLine | null> {
  const { data: conv, error: convError } = await db
    .from('conversations')
    .select('account_id, line_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (convError) {
    throw new LineUnavailableError(`No se pudo leer la conversación: ${convError.message}`);
  }
  if (!conv) return null;
  const { account_id, line_id } = conv as { account_id: string; line_id: string | null };
  if (!line_id) return usable(await getPrimaryLine(db, account_id));
  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('id', line_id)
    .maybeSingle();
  if (error || !data) {
    throw new LineUnavailableError(
      error ? `No se pudo leer la línea: ${error.message}` : undefined,
    );
  }
  return usable(data as WhatsAppLine);
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
  const { data, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('id', lineId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    throw new LineUnavailableError(`No se pudo leer la línea: ${error.message}`, { transient: true });
  }
  return usable((data as WhatsAppLine | null) ?? null);
}

/** `line_id` pedido en una ruta que no existe o es de otra cuenta (404). */
export class LineNotFoundError extends Error {
  constructor(message = 'La línea de WhatsApp indicada no existe en esta cuenta.') {
    super(message);
    this.name = 'LineNotFoundError';
  }
}

/**
 * Línea para plantillas y difusiones: la indicada en `lineId` (solo si es de
 * la cuenta) o, sin `lineId`, la principal. Devuelve null solo cuando la
 * cuenta no tiene ninguna línea. Lanza LineNotFoundError si `lineId` no
 * existe o es de otra cuenta, y LineUnavailableError si la línea está
 * desconectada o no se pudo leer (nunca se cae a otra línea).
 */
export async function resolveAccountLine(
  db: SupabaseClient,
  accountId: string,
  lineId?: unknown,
): Promise<WhatsAppLine | null> {
  const wanted = typeof lineId === 'string' ? lineId.trim() : '';
  if (wanted) {
    const line = await getLineById(db, accountId, wanted);
    if (!line) throw new LineNotFoundError();
    return line;
  }
  const { data, error } = await readPrimaryLine(db, accountId);
  if (error) {
    throw new LineUnavailableError(`No se pudo leer la línea: ${error.message}`, { transient: true });
  }
  return usable((data as WhatsAppLine | null) ?? null);
}

/**
 * Línea por la que sale un envío: la de la conversación; si no hay
 * conversación, la indicada en `lineId`; si tampoco, la principal.
 * Solo una conversación SIN line_id usa la principal; si tiene line_id y la
 * línea falla o no existe (o es de otra cuenta), lanza LineUnavailableError.
 * Una conversación inexistente cae a la principal (como antes).
 */
export async function resolveSendLine(
  db: SupabaseClient,
  accountId: string,
  opts: { conversationId?: string | null; lineId?: string | null } = {},
): Promise<WhatsAppLine | null> {
  if (opts.conversationId) {
    const line = await getLineForConversation(db, opts.conversationId);
    if (!line) return usable(await getPrimaryLine(db, accountId));
    if (line.account_id !== accountId) throw new LineUnavailableError();
    return line;
  }
  if (opts.lineId) return getLineById(db, accountId, opts.lineId);
  return usable(await getPrimaryLine(db, accountId));
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
