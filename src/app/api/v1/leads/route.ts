// ============================================================
// POST /api/v1/leads — capture a campaign / ad / landing-page lead
// (scope: contacts:write).
//
// Point your Meta Lead Ads bridge, Google Ads lead-form webhook, or a
// landing-page form here. Given a phone number (+ optional name/email
// and attribution), it:
//   1. find-or-creates the contact, recording first-touch attribution
//      (lead_source / campaign_name / ad_id / utm_*);
//   2. ensures a conversation exists for the contact;
//   3. fires the `new_contact_created` automation trigger — which, with
//      an `assign_conversation` (round-robin) step, auto-distributes the
//      lead to an advisor.
//
// Auth derives the account from the API key, so a lead can only ever
// land in the key's own account — no cross-account guessing (unlike the
// legacy, hardcoded /api/public/leads route this replaces).
// ============================================================

import { after } from 'next/server';

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { ContactError } from '@/lib/api/v1/contacts';
import { captureLead, type LeadInput } from '@/lib/api/v1/leads';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { runAutomationsForTrigger } from '@/lib/automations/engine';

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

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const phone = str(body.phone)?.trim() ?? '';
    if (!phone) {
      return fail('bad_request', "'phone' is required", 400);
    }

    const input: LeadInput = {
      phone,
      name: str(body.name),
      email: str(body.email),
    };
    for (const key of ATTRIBUTION_KEYS) {
      input[key] = str(body[key]);
    }

    const result = await captureLead(ctx.supabase, ctx.accountId, input);

    // Emit conversation.created for parity with the inbound webhook, so
    // outbound-webhook subscribers see the thread open.
    if (result.conversationCreated) {
      await dispatchWebhookEvent(
        ctx.supabase,
        ctx.accountId,
        'conversation.created',
        {
          conversation_id: result.conversationId,
          contact_id: result.contactId,
        }
      );
    }

    // Fire new_contact_created only for genuinely new contacts — same
    // semantic as the webhook. This is what runs the round-robin
    // assignment. Deferred via after() so a slow automation (e.g. a
    // welcome send) can't delay the caller's response, while still
    // running to completion on serverless.
    if (result.contactCreated) {
      after(
        runAutomationsForTrigger({
          accountId: ctx.accountId,
          triggerType: 'new_contact_created',
          contactId: result.contactId,
          context: { conversation_id: result.conversationId },
        }).catch((err) =>
          console.error('[api/v1/leads] automation dispatch failed:', err)
        )
      );
    }

    return ok(
      {
        contact_id: result.contactId,
        conversation_id: result.conversationId,
        contact_created: result.contactCreated,
        conversation_created: result.conversationCreated,
      },
      result.contactCreated ? 201 : 200
    );
  } catch (err) {
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
