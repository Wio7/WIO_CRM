// ============================================================
// Lead capture for the public API (POST /api/v1/leads).
//
// A "lead" is a contact that arrived from an ad / campaign / landing
// page. This differs from POST /api/v1/contacts in two ways:
//   1. it records campaign attribution (source / campaign / ad / utm_*),
//      first-touch — an existing contact's original source is preserved;
//   2. it guarantees a conversation exists for the contact, so the
//      `new_contact_created` automation's `assign_conversation` step has
//      a row to assign — this is what auto-distributes campaign leads to
//      advisors via round-robin.
//
// Reuses the exact contact dedupe / audit-user conventions the webhook
// and the rest of the public API use (findExistingContact,
// resolveAuditUserId), so a lead-captured contact is indistinguishable
// from a webhook- or dashboard-created one.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';

/** The attribution columns added in migration 035. */
export interface LeadAttribution {
  lead_source?: string | null;
  campaign_name?: string | null;
  ad_id?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_term?: string | null;
  utm_content?: string | null;
}

const ATTRIBUTION_KEYS = [
  'lead_source',
  'campaign_name',
  'ad_id',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;

export interface LeadInput extends LeadAttribution {
  phone: string;
  name?: string | null;
  email?: string | null;
}

export interface CapturedLead {
  contactId: string;
  conversationId: string;
  /** True if this call created the contact (vs matched an existing one). */
  contactCreated: boolean;
  /** True if this call opened the conversation (vs found an existing one). */
  conversationCreated: boolean;
}

/** Keep only the attribution keys that carry a non-empty string value. */
function cleanAttribution(input: LeadAttribution): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ATTRIBUTION_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') {
      out[key] = value.trim();
    }
  }
  return out;
}

/**
 * Find-or-create the contact + conversation for a lead, recording
 * first-touch attribution. Throws `ContactError` (mapped by the route)
 * on a bad phone or a DB failure.
 *
 * Unlike `resolveConversationByPhone`, this does NOT require WhatsApp to
 * be configured — leads legitimately arrive before an account connects
 * WhatsApp, and capturing them must never be blocked by that.
 */
export async function captureLead(
  db: SupabaseClient,
  accountId: string,
  input: LeadInput
): Promise<CapturedLead> {
  const sanitized = sanitizePhoneForMeta(input.phone);
  if (!isValidE164(sanitized)) {
    throw new ContactError(
      "'phone' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400
    );
  }

  const auditUserId = await resolveAuditUserId(db, accountId);
  const attribution = cleanAttribution(input);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim() : '';

  // ---- contact -------------------------------------------------
  let contactId: string;
  let contactCreated = false;

  const existing = await findExistingContact(db, accountId, sanitized);
  if (existing) {
    contactId = existing.id;
    // First-touch attribution: only fill columns that are currently
    // empty, so a returning lead never clobbers its original source.
    const { data: current } = await db
      .from('contacts')
      .select('name, email, ' + ATTRIBUTION_KEYS.join(', '))
      .eq('id', contactId)
      .maybeSingle();
    const row = (current ?? {}) as Record<string, unknown>;

    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attribution)) {
      if (row[key] == null || row[key] === '') patch[key] = value;
    }
    if (name && !row.name) patch.name = name;
    if (email && !row.email) patch.email = email;

    if (Object.keys(patch).length > 0) {
      patch.updated_at = new Date().toISOString();
      await db.from('contacts').update(patch).eq('id', contactId);
    }
  } else {
    const { data: created, error } = await db
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: auditUserId,
        phone: sanitized,
        name: name || sanitized,
        email: email || null,
        ...attribution,
      })
      .select('id')
      .single();

    if (error || !created) {
      // Lost a race against a concurrent create — the unique index
      // (migration 022) rejected the duplicate. Re-resolve to the winner.
      if (isUniqueViolation(error)) {
        const raced = await findExistingContact(db, accountId, sanitized);
        if (raced) {
          contactId = raced.id;
        } else {
          throw new ContactError('Failed to create contact', 500);
        }
      } else {
        console.error('[api/v1/leads] contact create error:', error);
        throw new ContactError('Failed to create contact', 500);
      }
    } else {
      contactId = created.id;
      contactCreated = true;
    }
  }

  // ---- conversation -------------------------------------------
  // One conversation per (account, contact) — same convention as the
  // webhook and resolve-conversation.
  let conversationCreated = false;
  const { data: conv } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle();

  let conversationId: string;
  if (conv?.id) {
    conversationId = conv.id;
  } else {
    const { data: newConv, error: convErr } = await db
      .from('conversations')
      .insert({
        account_id: accountId,
        user_id: auditUserId,
        contact_id: contactId,
      })
      .select('id')
      .single();
    if (convErr || !newConv) {
      console.error('[api/v1/leads] conversation create error:', convErr);
      throw new ContactError('Failed to create conversation', 500);
    }
    conversationId = newConv.id;
    conversationCreated = true;
  }

  return { contactId, conversationId, contactCreated, conversationCreated };
}
