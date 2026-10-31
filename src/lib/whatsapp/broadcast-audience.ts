// ============================================================
// Browser-side half of a broadcast: turn the wizard's audience into
// contact ids, then persist the broadcast + one 'pending' recipient per
// person. Nothing is sent here — GET /api/broadcasts/cron
// (broadcast-dispatch.ts) does the sending, for "send now" and for a
// scheduled date alike.
//
// Every read is paginated (PostgREST caps responses at 1000 rows) and
// every `.in(...)` is chunked, so a 1500-person audience is complete.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { chunk, fetchAllPages } from '@/lib/supabase/paginate';
import {
  isValidE164,
  phoneVariants,
  sanitizePhoneForMeta,
} from '@/lib/whatsapp/phone-utils';
import type { VariableMapping } from '@/lib/whatsapp/broadcast-variables';
import type { MessageTemplate } from '@/types';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

export interface CreateServerBroadcastInput {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /** Media URL for an IMAGE/VIDEO/DOCUMENT header template. */
  headerMediaUrl?: string;
  /** When to send. "Now" is simply the current instant. */
  scheduledAt: Date;
}

/** Rows per recipient INSERT request. */
const INSERT_BATCH_SIZE = 200;
/** Phones per existing-contact lookup (each expands to ~7 variants). */
const PHONE_LOOKUP_CHUNK = 30;

type Db = SupabaseClient;

// ── Audience -> contact ids ─────────────────────────────────────────

async function selectAccountContactIds(
  db: Db,
  accountId: string,
  ids: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const part of chunk(ids)) {
    const { data, error } = await db
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .in('id', part);
    if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
    for (const row of data ?? []) out.push(row.id as string);
  }
  return out;
}

async function contactIdsWithTags(db: Db, tagIds: string[]): Promise<string[]> {
  const rows = await fetchAllPages<{ contact_id: string }>((from, to) =>
    db
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', tagIds)
      .order('contact_id', { ascending: true })
      .order('tag_id', { ascending: true })
      .range(from, to),
  );
  return [...new Set(rows.map((r) => r.contact_id))];
}

async function resolveCustomFieldIds(
  db: Db,
  accountId: string,
  filter: CustomFieldFilter,
): Promise<string[]> {
  const { fieldId, operator, value } = filter;
  const rows = await fetchAllPages<{ contact_id: string }>((from, to) => {
    let query = db
      .from('contact_custom_values')
      .select('contact_id')
      .eq('custom_field_id', fieldId);
    if (operator === 'is') query = query.eq('value', value);
    else if (operator === 'is_not') query = query.neq('value', value);
    else if (operator === 'contains') query = query.ilike('value', `%${value}%`);
    return query
      .order('contact_id', { ascending: true })
      .order('custom_field_id', { ascending: true })
      .range(from, to);
  });
  const ids = [...new Set(rows.map((r) => r.contact_id))];
  return selectAccountContactIds(db, accountId, ids);
}

/**
 * CSV/Excel rows are bare phone/name pairs, but recipients FK
 * contacts.id. Match each phone to an existing contact of THIS account
 * (also by trunk-prefix variants, since contacts.phone_normalized is
 * unique per account), create the rest, and return the contact ids.
 */
export async function upsertCsvContacts(
  db: Db,
  accountId: string,
  userId: string,
  csvRows: { phone: string; name?: string }[],
): Promise<string[]> {
  const byPhone = new Map<string, { phone: string; name?: string }>();
  for (const row of csvRows) {
    const phone = sanitizePhoneForMeta(row.phone ?? '');
    if (isValidE164(phone) && !byPhone.has(phone)) {
      byPhone.set(phone, { phone, name: row.name });
    }
  }
  const phones = [...byPhone.keys()];
  if (phones.length === 0) return [];

  // 1) Existing contacts, matched on any variant of each phone.
  const existingByNormalized = new Map<string, string>();
  for (const part of chunk(phones, PHONE_LOOKUP_CHUNK)) {
    const variants = [...new Set(part.flatMap((p) => phoneVariants(p)))];
    const { data, error } = await db
      .from('contacts')
      .select('id, phone_normalized')
      .eq('account_id', accountId)
      .in('phone_normalized', variants);
    if (error) throw new Error(`Failed to look up CSV contacts: ${error.message}`);
    for (const c of data ?? []) {
      existingByNormalized.set(c.phone_normalized as string, c.id as string);
    }
  }

  const ids = new Set<string>();
  const missing: { phone: string; name?: string }[] = [];
  for (const phone of phones) {
    const hit = phoneVariants(phone)
      .map((v) => existingByNormalized.get(v))
      .find((id): id is string => Boolean(id));
    if (hit) ids.add(hit);
    else missing.push(byPhone.get(phone)!);
  }

  // 2) Create the missing ones.
  const toRow = (r: { phone: string; name?: string }) => ({
    user_id: userId,
    account_id: accountId,
    phone: r.phone,
    name: r.name ?? null,
  });
  for (const part of chunk(missing, INSERT_BATCH_SIZE)) {
    const { data, error } = await db
      .from('contacts')
      .insert(part.map(toRow))
      .select('id');
    if (!error) {
      for (const c of data ?? []) ids.add(c.id as string);
      continue;
    }
    if (error.code !== '23505') {
      throw new Error(`Failed to create CSV contacts: ${error.message}`);
    }
    // A unique (account, phone_normalized) clash somewhere in the batch
    // (e.g. a contact created meanwhile): redo it row by row.
    for (const r of part) {
      const one = await db.from('contacts').insert(toRow(r)).select('id').single();
      if (!one.error && one.data) {
        ids.add(one.data.id as string);
        continue;
      }
      if (one.error?.code !== '23505') {
        throw new Error(
          `Failed to create CSV contacts: ${one.error?.message ?? 'unknown error'}`,
        );
      }
      const { data: found } = await db
        .from('contacts')
        .select('id')
        .eq('account_id', accountId)
        .eq('phone_normalized', r.phone)
        .maybeSingle();
      if (found) ids.add(found.id as string);
    }
  }

  return [...ids];
}

/** Contact ids the audience resolves to, exclusions already applied. */
export async function resolveAudienceContactIds(
  db: Db,
  accountId: string,
  userId: string,
  audience: AudienceConfig,
): Promise<string[]> {
  let ids: string[] = [];

  if (audience.type === 'all') {
    const rows = await fetchAllPages<{ id: string }>((from, to) =>
      db
        .from('contacts')
        .select('id')
        .eq('account_id', accountId)
        .order('id', { ascending: true })
        .range(from, to),
    );
    ids = rows.map((r) => r.id);
  } else if (audience.type === 'tags' && audience.tagIds?.length) {
    const tagged = await contactIdsWithTags(db, audience.tagIds);
    ids = await selectAccountContactIds(db, accountId, tagged);
  } else if (audience.type === 'custom_field' && audience.customField) {
    ids = await resolveCustomFieldIds(db, accountId, audience.customField);
  } else if (audience.type === 'csv' && audience.csvContacts) {
    ids = await upsertCsvContacts(db, accountId, userId, audience.csvContacts);
  }

  if (audience.excludeTagIds?.length) {
    const excluded = new Set(await contactIdsWithTags(db, audience.excludeTagIds));
    ids = ids.filter((id) => !excluded.has(id));
  }

  return [...new Set(ids)];
}

// ── Persist ─────────────────────────────────────────────────────────

/**
 * Create the broadcast and its pending recipients; returns the id.
 *
 * Order matters: the row is born as a 'draft' and only flips to
 * 'scheduled' (compare-and-swap) AFTER every recipient exists, so the
 * dispatcher can never pick up a half-filled broadcast and close it as
 * finished.
 */
export async function createServerBroadcast(
  db: Db,
  ctx: { accountId: string; userId: string },
  input: CreateServerBroadcastInput,
  onProgress?: (percent: number) => void,
): Promise<string> {
  const { accountId, userId } = ctx;
  onProgress?.(5);
  const contactIds = await resolveAudienceContactIds(
    db,
    accountId,
    userId,
    input.audience,
  );
  if (contactIds.length === 0) {
    throw new Error('No hay contactos en esta audiencia.');
  }

  onProgress?.(30);
  const headerMediaUrl = input.headerMediaUrl?.trim() || undefined;
  const { data: broadcast, error: broadcastError } = await db
    .from('broadcasts')
    .insert({
      user_id: userId,
      account_id: accountId,
      name: input.name,
      template_name: input.template.name,
      template_language: input.template.language ?? 'en_US',
      template_variables: input.variables,
      audience_filter: {
        type: input.audience.type,
        tagIds: input.audience.tagIds,
        customField: input.audience.customField,
        excludeTagIds: input.audience.excludeTagIds,
        // Marker: only rows carrying it are ever sent by the server.
        dispatch: 'server',
        headerMediaUrl,
      },
      scheduled_at: input.scheduledAt.toISOString(),
      status: 'draft',
      total_recipients: contactIds.length,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    })
    .select('id')
    .single();
  if (broadcastError || !broadcast) {
    throw new Error(
      `No se pudo crear la difusión: ${broadcastError?.message ?? 'error desconocido'}`,
    );
  }
  const broadcastId = broadcast.id as string;

  const rows = contactIds.map((contactId) => ({
    broadcast_id: broadcastId,
    contact_id: contactId,
    status: 'pending' as const,
  }));
  const batches = chunk(rows, INSERT_BATCH_SIZE);
  for (let i = 0; i < batches.length; i++) {
    const { error } = await db.from('broadcast_recipients').insert(batches[i]);
    if (error) {
      // Never leave it eligible to send with a partial list.
      await db.from('broadcasts').update({ status: 'failed' }).eq('id', broadcastId);
      throw new Error(
        `No se pudieron guardar los destinatarios (lote ${i + 1}): ${error.message}`,
      );
    }
    onProgress?.(30 + Math.round(((i + 1) / batches.length) * 60));
  }

  const { data: armed, error: armError } = await db
    .from('broadcasts')
    .update({ status: 'scheduled' })
    .eq('id', broadcastId)
    .eq('status', 'draft')
    .select('id')
    .maybeSingle();
  if (armError || !armed) {
    throw new Error(
      `No se pudo programar la difusión: ${armError?.message ?? 'cambió de estado'}`,
    );
  }
  onProgress?.(100);
  return broadcastId;
}

/**
 * Cancel a scheduled broadcast (scheduled -> draft). Conditional on
 * status = 'scheduled', so if the dispatcher claimed it first (-> sending)
 * this changes nothing and reports it. Whichever UPDATE runs first wins.
 */
export async function cancelScheduledBroadcast(
  db: Db,
  broadcastId: string,
): Promise<{ cancelled: boolean; error?: string }> {
  const { data, error } = await db
    .from('broadcasts')
    .update({ status: 'draft' })
    .eq('id', broadcastId)
    .eq('status', 'scheduled')
    .select('id')
    .maybeSingle();
  if (error) return { cancelled: false, error: error.message };
  return { cancelled: Boolean(data) };
}
