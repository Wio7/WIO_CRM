// ============================================================
// Server-side dispatcher for scheduled / "send now" broadcasts.
//
// The wizard (browser) only PERSISTS a broadcast: a `broadcasts` row in
// status 'scheduled' (audience_filter.dispatch = 'server') plus one
// 'pending' `broadcast_recipients` row per person. Nothing is sent from
// the browser. GET /api/broadcasts/cron calls runBroadcastDispatch()
// every minute and this module does the sending, so a scheduled
// broadcast goes out even if the tab is closed.
//
// Safety rules (messages are paid and go to real people):
//
//   * Only rows marked audience_filter->>dispatch = 'server' are ever
//     touched. Older 'scheduled'/'sending' rows without the marker are
//     ignored on purpose.
//   * Claiming is a compare-and-swap UPDATE (scheduled -> sending, or a
//     stale 'sending' lease -> 'sending'), so two overlapping runs can
//     never both own a broadcast. The lease is `updated_at`: the BEFORE
//     UPDATE trigger bumps it on every write, and so does the
//     recipient-count trigger (migrations 003/005) each time a
//     recipient changes status. A run that dies stops bumping it and
//     the broadcast becomes claimable again 60 s later.
//   * Each recipient is settled with `.eq('status','pending')`, so a
//     recipient is never overwritten or re-sent.
//   * The admin client bypasses RLS: every query that can carry
//     account_id does, and broadcast_recipients / contact_custom_values
//     (which have none) are only read through a broadcast / contact ids
//     already validated against that account.
//   * Per-status counts on `broadcasts` belong to the DB trigger; this
//     module only writes the lifecycle `status`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { sendTemplateWithVariants } from '@/lib/whatsapp/broadcast-core';
import { isValidE164, phoneVariants, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import {
  resolveVariables,
  usesCustomFields,
  type CustomValueIndex,
  type VariableMapping,
} from '@/lib/whatsapp/broadcast-variables';
import { PAGE_SIZE, chunk, fetchAllPages } from '@/lib/supabase/paginate';
import type { Contact, MessageTemplate } from '@/types';

export interface DispatchOptions {
  /** Stop starting new batches after this long (default 240 s). */
  budgetMs?: number;
  /** A 'sending' broadcast is resumable once idle this long (60 s). */
  leaseMs?: number;
  /** Refresh updated_at at least this often while working (20 s). */
  heartbeatMs?: number;
  /** Messages per batch (10) and the pause after each batch (1 s). */
  batchSize?: number;
  batchDelayMs?: number;
  /** Give up on one Meta call after this long (30 s). */
  sendTimeoutMs?: number;
  /** Max broadcasts looked at per run, per kind (20). */
  maxCandidates?: number;
}

export interface DispatchDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  send?: typeof sendTemplateMessage;
  decryptToken?: (encrypted: string) => string;
}

export type BroadcastRunResult =
  | 'completed' // no pending left; final status written
  | 'failed' // broadcast marked failed (config/template/db problem)
  | 'budget' // time budget used up; remaining pending go next run
  | 'lost' // lease lost to another run; stopped without touching more
  | 'error'; // transient read error; stays 'sending', resumes later

export interface BroadcastRunOutcome {
  id: string;
  result: BroadcastRunResult;
  sent: number;
  failed: number;
}

export interface DispatchSummary {
  claimed: number;
  outcomes: BroadcastRunOutcome[];
}

const DEFAULTS: Required<DispatchOptions> = {
  budgetMs: 240_000,
  leaseMs: 60_000,
  heartbeatMs: 20_000,
  batchSize: 10,
  batchDelayMs: 1000,
  sendTimeoutMs: 30_000,
  maxCandidates: 20,
};

const LOG = '[broadcast-dispatch]';

/**
 * Meta said "not now": the recipient stays pending and the run ends, so
 * the 60 s lease works as the wait before the next attempt.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
 */
const RETRY_LATER_CODES = new Set([130429, 80007, 131056]);

/**
 * Every other recipient would fail the same way (and some would hurt the
 * number further), so these stop the whole broadcast. Pending recipients
 * are left untouched: they were never sent.
 */
const STOP_REASONS = new Map<number, string>([
  [131042, 'hay un problema con el método de pago de la cuenta de WhatsApp'],
  [131048, 'WhatsApp restringió el número por bloqueos o reportes de spam'],
  [131031, 'WhatsApp restringió o deshabilitó la cuenta'],
  [368, 'WhatsApp restringió la cuenta por una infracción de sus políticas'],
  [132015, 'Meta pausó la plantilla por baja calidad'],
  [132016, 'Meta deshabilitó la plantilla por baja calidad'],
  [132001, 'la plantilla no existe en ese idioma o no está aprobada'],
  [190, 'venció el token de WhatsApp'],
]);

interface Candidate {
  id: string;
  account_id: string;
  status: 'scheduled' | 'sending';
  scheduled_at: string | null;
  updated_at: string;
  template_name: string;
  template_language: string | null;
  template_variables: Record<string, VariableMapping> | null;
  audience_filter: Record<string, unknown> | null;
}

interface RunContext {
  db: SupabaseClient;
  cfg: Required<DispatchOptions>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  send: typeof sendTemplateMessage;
  decryptToken: (encrypted: string) => string;
  startedAt: number;
}

const CANDIDATE_COLUMNS =
  'id, account_id, status, scheduled_at, updated_at, template_name, template_language, template_variables, audience_filter';

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runBroadcastDispatch(
  db: SupabaseClient,
  options: DispatchOptions = {},
  deps: DispatchDeps = {},
): Promise<DispatchSummary> {
  const now = deps.now ?? Date.now;
  const ctx: RunContext = {
    db,
    cfg: { ...DEFAULTS, ...options },
    now,
    sleep: deps.sleep ?? defaultSleep,
    send: deps.send ?? sendTemplateMessage,
    decryptToken: deps.decryptToken ?? decrypt,
    startedAt: now(),
  };

  const summary: DispatchSummary = { claimed: 0, outcomes: [] };
  const candidates = await findCandidates(ctx);

  for (const candidate of candidates) {
    if (outOfBudget(ctx)) break;
    if (!(await claim(ctx, candidate))) continue;
    summary.claimed++;
    summary.outcomes.push(await processBroadcast(ctx, candidate));
  }
  return summary;
}

function outOfBudget(ctx: RunContext): boolean {
  return ctx.now() - ctx.startedAt >= ctx.cfg.budgetMs;
}

// ── Finding and claiming ────────────────────────────────────────────

/**
 * The only cross-account query: it has to look across every account to
 * find due work, which is why it is restricted to the 'server' marker
 * and returns each row's own account_id. Everything after this uses it.
 */
async function findCandidates(ctx: RunContext): Promise<Candidate[]> {
  const { db, cfg } = ctx;
  const nowIso = new Date(ctx.now()).toISOString();
  const leaseCutoff = new Date(ctx.now() - cfg.leaseMs).toISOString();

  // Interrupted runs first (they already started), then newly due ones.
  const stale = await db
    .from('broadcasts')
    .select(CANDIDATE_COLUMNS)
    .eq('audience_filter->>dispatch', 'server')
    .eq('status', 'sending')
    .lt('updated_at', leaseCutoff)
    .order('updated_at', { ascending: true })
    .limit(cfg.maxCandidates);
  if (stale.error) console.error(`${LOG} stale lookup failed:`, stale.error);

  const due = await db
    .from('broadcasts')
    .select(CANDIDATE_COLUMNS)
    .eq('audience_filter->>dispatch', 'server')
    .eq('status', 'scheduled')
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(cfg.maxCandidates);
  if (due.error) console.error(`${LOG} due lookup failed:`, due.error);

  return [...(stale.data ?? []), ...(due.data ?? [])] as Candidate[];
}

/** Compare-and-swap into 'sending'. True only for the single winner. */
async function claim(ctx: RunContext, c: Candidate): Promise<boolean> {
  const nowIso = new Date(ctx.now()).toISOString();
  let query = ctx.db
    .from('broadcasts')
    .update({ status: 'sending', updated_at: nowIso })
    .eq('id', c.id)
    .eq('account_id', c.account_id)
    .eq('audience_filter->>dispatch', 'server')
    .eq('status', c.status);

  if (c.status === 'scheduled') {
    // Still scheduled and still due: a cancel (-> draft) or a
    // rescheduled-into-the-future row makes this match nothing.
    query = query.lte('scheduled_at', nowIso);
  } else {
    // Resume only the exact lease we saw, and only if it is stale.
    query = query
      .lt('updated_at', new Date(ctx.now() - ctx.cfg.leaseMs).toISOString())
      .eq('updated_at', c.updated_at);
  }

  const { data, error } = await query.select('id').maybeSingle();
  if (error) {
    console.error(`${LOG} claim failed for ${c.id}:`, error);
    return false;
  }
  return Boolean(data);
}

// ── Working a claimed broadcast ─────────────────────────────────────

async function processBroadcast(
  ctx: RunContext,
  b: Candidate,
): Promise<BroadcastRunOutcome> {
  const { db } = ctx;
  const outcome = (
    result: BroadcastRunResult,
    sent = 0,
    failed = 0,
  ): BroadcastRunOutcome => ({ id: b.id, result, sent, failed });

  const fail = async (reason: string) => {
    console.error(`${LOG} broadcast ${b.id} failed: ${reason}`);
    await setStatus(ctx, b, 'failed', reason);
    return outcome('failed');
  };

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', b.account_id)
    .maybeSingle();
  if (configError) {
    console.error(`${LOG} config read failed for ${b.id}:`, configError);
    return outcome('error');
  }
  if (!config) return fail('la cuenta no tiene whatsapp_config');

  let accessToken: string;
  try {
    accessToken = ctx.decryptToken(config.access_token as string);
  } catch (err) {
    return fail(
      `no se pudo descifrar el token de WhatsApp (${err instanceof Error ? err.message : 'error'})`,
    );
  }

  const language = b.template_language || 'en_US';
  const { data: rawTemplate, error: templateError } = await db
    .from('message_templates')
    .select('*')
    .eq('account_id', b.account_id)
    .eq('name', b.template_name)
    .eq('language', language)
    .maybeSingle();
  if (templateError) {
    console.error(`${LOG} template read failed for ${b.id}:`, templateError);
    return outcome('error');
  }
  if (!rawTemplate) {
    return fail(`la plantilla ${b.template_name} (${language}) no existe`);
  }
  if (!isMessageTemplate(rawTemplate)) {
    return fail(`la plantilla ${b.template_name} está dañada localmente`);
  }
  const template = rawTemplate as MessageTemplate;

  // Media-header templates need the URL chosen in the wizard.
  const headerType = template.header_type;
  const isMediaHeader =
    headerType === 'image' || headerType === 'video' || headerType === 'document';
  const mediaUrl =
    typeof b.audience_filter?.headerMediaUrl === 'string'
      ? b.audience_filter.headerMediaUrl.trim()
      : '';
  const messageParams =
    isMediaHeader && mediaUrl ? { headerMediaUrl: mediaUrl } : undefined;

  const variables = b.template_variables ?? {};
  const needsCustom = usesCustomFields(variables);

  let sent = 0;
  let failed = 0;
  let lastBeat = ctx.now();
  let lastId: string | null = null;

  for (;;) {
    if (outOfBudget(ctx)) return outcome('budget', sent, failed);

    // Keyset paging on id: rows leave the pending set as we settle
    // them, so offset paging would skip rows.
    let pageQuery = db
      .from('broadcast_recipients')
      .select('id, contact_id')
      .eq('broadcast_id', b.id)
      .eq('status', 'pending')
      .order('id', { ascending: true })
      .limit(PAGE_SIZE);
    if (lastId) pageQuery = pageQuery.gt('id', lastId);
    const { data: page, error: pageError } = await pageQuery;
    if (pageError) {
      console.error(`${LOG} recipients read failed for ${b.id}:`, pageError);
      return outcome('error', sent, failed);
    }
    const rows = (page ?? []) as { id: string; contact_id: string | null }[];
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    let contacts: Map<string, Contact>;
    let customIndex: CustomValueIndex;
    let optedOut: Set<string>;
    try {
      const contactIds = [
        ...new Set(rows.map((r) => r.contact_id).filter((id): id is string => !!id)),
      ];
      contacts = await loadContacts(ctx, b.account_id, contactIds);
      customIndex = needsCustom
        ? await loadCustomValues(ctx, [...contacts.keys()])
        : new Map();
      // Read here, right before sending, so a BAJA received after the
      // broadcast was scheduled still counts. A failed read sends nothing.
      optedOut = await loadOptedOut(ctx, b.account_id, [...contacts.values()]);
    } catch (err) {
      console.error(`${LOG} contact read failed for ${b.id}:`, err);
      return outcome('error', sent, failed);
    }

    for (const batch of chunk(rows, ctx.cfg.batchSize)) {
      if (outOfBudget(ctx)) return outcome('budget', sent, failed);

      if (ctx.now() - lastBeat >= ctx.cfg.heartbeatMs) {
        if (!(await heartbeat(ctx, b))) return outcome('lost', sent, failed);
        lastBeat = ctx.now();
      }

      const results = await Promise.all(
        batch.map((row) =>
          dispatchRecipient(ctx, {
            row,
            contact: row.contact_id ? contacts.get(row.contact_id) : undefined,
            customIndex,
            optedOut,
            variables,
            config: {
              phoneNumberId: config.phone_number_id as string,
              accessToken,
            },
            template,
            language,
            templateName: b.template_name,
            messageParams,
          }),
        ),
      );
      for (const r of results) {
        if (r.sent) sent++;
        else if (!r.retryLater && !r.stopReason) failed++;
      }

      // A message went out but we could not record it. Resuming would
      // send it again, so stop the whole broadcast instead.
      if (results.some((r) => r.unrecordedSend)) {
        return fail(
          'se envió un mensaje pero no se pudo guardar el resultado; se detiene para no duplicar envíos',
        ).then((o) => ({ ...o, sent, failed }));
      }

      const stopReason = results.find((r) => r.stopReason)?.stopReason;
      if (stopReason) {
        return fail(stopReason).then((o) => ({ ...o, sent, failed }));
      }
      if (results.some((r) => r.retryLater)) {
        return outcome('budget', sent, failed);
      }

      await ctx.sleep(ctx.cfg.batchDelayMs);
    }
  }

  // The loop ended on an empty page. Double-check nothing is pending
  // before declaring the broadcast finished.
  const pending = await countRecipients(ctx, b.id, (q) => q.eq('status', 'pending'));
  if (pending === null) return outcome('error', sent, failed);
  if (pending > 0) return outcome('budget', sent, failed);

  const delivered = await countRecipients(ctx, b.id, (q) =>
    q.not('status', 'in', '(pending,failed)'),
  );
  if (delivered === null) return outcome('error', sent, failed);

  await setStatus(ctx, b, delivered > 0 ? 'sent' : 'failed');
  return outcome('completed', sent, failed);
}

interface RecipientJob {
  row: { id: string; contact_id: string | null };
  contact: Contact | undefined;
  customIndex: CustomValueIndex;
  optedOut: Set<string>;
  variables: Record<string, VariableMapping>;
  config: { phoneNumberId: string; accessToken: string };
  template: MessageTemplate;
  language: string;
  templateName: string;
  messageParams: { headerMediaUrl: string } | undefined;
}

interface RecipientResult {
  sent: boolean;
  unrecordedSend: boolean;
  /** Left pending: Meta asked to slow down. */
  retryLater?: boolean;
  /** Left pending: the whole broadcast has to stop, for this reason. */
  stopReason?: string;
}

/**
 * One recipient: resolve, send, settle. A recipient with no contact
 * (contact deleted -> contact_id NULL, migration 004) or no usable phone
 * is marked failed so it never blocks the queue.
 */
async function dispatchRecipient(
  ctx: RunContext,
  job: RecipientJob,
): Promise<RecipientResult> {
  const { row, contact } = job;

  const failWith = async (message: string) => {
    await settle(ctx, row.id, { status: 'failed', error_message: message });
    return { sent: false, unrecordedSend: false };
  };

  if (!contact) return failWith('El contacto ya no existe');
  const phone = sanitizePhoneForMeta(contact.phone ?? '');
  if (!phone) return failWith('El contacto no tiene teléfono');
  if (!isValidE164(phone)) return failWith('Número de teléfono inválido');
  if (phoneVariants(phone).some((v) => job.optedOut.has(v))) {
    return failWith('Pidió no recibir mensajes de esta cuenta');
  }

  const params = resolveVariables(
    job.variables,
    contact,
    job.customIndex.get(contact.id),
  );

  const outcome = await withTimeout(
    sendTemplateWithVariants({
      phoneNumberId: job.config.phoneNumberId,
      accessToken: job.config.accessToken,
      phone,
      templateName: job.templateName,
      language: job.language,
      template: job.template,
      params,
      messageParams: job.messageParams,
      send: ctx.send,
    }),
    ctx.cfg.sendTimeoutMs,
  );

  if (outcome === TIMED_OUT) {
    // Unknown whether Meta accepted it. Not retrying is the safe
    // side: a duplicate paid message is worse than one failed row.
    return failWith(
      'Meta no respondió a tiempo; no se reintenta para no duplicar el mensaje',
    );
  }

  if (outcome.messageId) {
    const result = await settle(ctx, row.id, {
      status: 'sent',
      sent_at: new Date(ctx.now()).toISOString(),
      // The status webhook matches delivered/read on this column.
      whatsapp_message_id: outcome.messageId,
      // Meta accepted it but may drop it later; the status webhook clears
      // this note on delivery or replaces it with the failure reason.
      error_message:
        outcome.messageStatus === 'held_for_quality_assessment'
          ? 'Meta lo retuvo mientras evalúa la calidad de la plantilla'
          : null,
    });
    return { sent: true, unrecordedSend: result === 'db_error' };
  }

  if (outcome.errorCode !== null) {
    if (RETRY_LATER_CODES.has(outcome.errorCode)) {
      return { sent: false, unrecordedSend: false, retryLater: true };
    }
    const stopReason = STOP_REASONS.get(outcome.errorCode);
    if (stopReason) return { sent: false, unrecordedSend: false, stopReason };
  }

  return failWith(outcome.error || 'Unknown error');
}

const TIMED_OUT = Symbol('timed-out');

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Write a recipient's outcome, only while it is still 'pending'.
 * 'raced' = someone else already settled it (nothing to do).
 */
async function settle(
  ctx: RunContext,
  recipientId: string,
  patch: Record<string, unknown>,
): Promise<'saved' | 'raced' | 'db_error'> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await ctx.db
      .from('broadcast_recipients')
      .update(patch)
      .eq('id', recipientId)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (!error) return data ? 'saved' : 'raced';
    console.error(`${LOG} recipient ${recipientId} update failed:`, error);
    if (attempt < 2) await ctx.sleep(200);
  }
  return 'db_error';
}

/** Keep the lease alive. False when the broadcast is no longer ours. */
async function heartbeat(ctx: RunContext, b: Candidate): Promise<boolean> {
  const { data, error } = await ctx.db
    .from('broadcasts')
    .update({ status: 'sending', updated_at: new Date(ctx.now()).toISOString() })
    .eq('id', b.id)
    .eq('account_id', b.account_id)
    .eq('status', 'sending')
    .select('id')
    .maybeSingle();
  if (error) {
    console.error(`${LOG} heartbeat failed for ${b.id}:`, error);
    return true; // transient; keep going
  }
  return Boolean(data);
}

/** Final status, only from 'sending' so a concurrent change wins. */
async function setStatus(
  ctx: RunContext,
  b: Candidate,
  status: 'sent' | 'failed',
  stopReason?: string,
): Promise<void> {
  const { error } = await ctx.db
    .from('broadcasts')
    .update({
      status,
      updated_at: new Date(ctx.now()).toISOString(),
      // Shown on the detail page; there is no dedicated column for it.
      ...(stopReason ? { audience_filter: { ...b.audience_filter, stopReason } } : {}),
    })
    .eq('id', b.id)
    .eq('account_id', b.account_id)
    .eq('status', 'sending');
  if (error) console.error(`${LOG} status update failed for ${b.id}:`, error);
}

async function countRecipients(
  ctx: RunContext,
  broadcastId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  refine: (q: any) => any,
): Promise<number | null> {
  const base = ctx.db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);
  const { count, error } = await refine(base);
  if (error) {
    console.error(`${LOG} count failed for ${broadcastId}:`, error);
    return null;
  }
  return count ?? 0;
}

// ── Reads (always bounded: chunked .in, paged ranges) ───────────────

async function loadContacts(
  ctx: RunContext,
  accountId: string,
  contactIds: string[],
): Promise<Map<string, Contact>> {
  const out = new Map<string, Contact>();
  for (const ids of chunk(contactIds)) {
    const { data, error } = await ctx.db
      .from('contacts')
      .select('id, account_id, name, phone, email, company')
      .eq('account_id', accountId)
      .in('id', ids);
    if (error) throw new Error(error.message);
    for (const c of (data ?? []) as Contact[]) out.set(c.id, c);
  }
  return out;
}

/** Which of these contacts' phone variants are on the account's list. */
async function loadOptedOut(
  ctx: RunContext,
  accountId: string,
  contacts: Contact[],
): Promise<Set<string>> {
  const variants = [
    ...new Set(
      contacts.flatMap((c) => phoneVariants(sanitizePhoneForMeta(c.phone ?? ''))),
    ),
  ];
  const out = new Set<string>();
  for (const part of chunk(variants)) {
    const { data, error } = await ctx.db
      .from('do_not_call')
      .select('phone_normalized')
      .eq('account_id', accountId)
      .in('phone_normalized', part);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) out.add(row.phone_normalized as string);
  }
  return out;
}

/**
 * contact_custom_values has no account_id column; it is only read for
 * ids that loadContacts already confirmed belong to the account.
 */
async function loadCustomValues(
  ctx: RunContext,
  contactIds: string[],
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  for (const ids of chunk(contactIds)) {
    const rows = await fetchAllPages<{
      contact_id: string;
      custom_field_id: string;
      value: string | null;
    }>((from, to) =>
      ctx.db
        .from('contact_custom_values')
        .select('contact_id, custom_field_id, value')
        .in('contact_id', ids)
        .order('contact_id', { ascending: true })
        .order('custom_field_id', { ascending: true })
        .range(from, to),
    );
    for (const r of rows) {
      const bucket = index.get(r.contact_id) ?? new Map<string, string>();
      bucket.set(r.custom_field_id, r.value ?? '');
      index.set(r.contact_id, bucket);
    }
  }
  return index;
}
