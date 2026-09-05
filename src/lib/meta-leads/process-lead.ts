// ============================================================
// Shared `leadgen` processing, used by BOTH Meta webhooks:
//
//   * /api/meta/webhook            — shared WIO.CRM app, routes by page_id
//   * /api/meta/leads/[token]      — account brought its own Meta App
//
// Same work either way once the account and Page token are resolved:
// fetch the answers from the Graph API, map them, create/merge the
// contact with attribution, keep custom answers as a note, and fire
// `new_contact_created` so the round-robin assigns an advisor.
//
// Idempotency: Meta retries a delivery until it gets a 200 and may
// redeliver after one. We claim each `leadgen_id` in `meta_lead_events`
// (PK) before doing any work — a duplicate claim means someone already
// handled it, so we skip. On failure the claim is released so Meta's
// retry can succeed; otherwise a transient Graph error would permanently
// swallow the lead.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { captureLead } from '@/lib/api/v1/leads';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { fetchLeadDetail } from '@/lib/meta-leads/graph';
import { mapLeadFields } from '@/lib/meta-leads/map-fields';

export interface LeadgenValue {
  leadgen_id?: string;
  page_id?: string;
  form_id?: string;
  ad_id?: string;
  created_time?: number;
}

/**
 * Process a batch of leadgen events for one account. Best-effort per
 * lead — one failure never blocks the rest of the batch. Call from
 * `after()` so a slow Graph round-trip can't make Meta time out.
 */
export async function processLeadgenValues(
  db: SupabaseClient,
  accountId: string,
  pageToken: string | null,
  values: LeadgenValue[],
): Promise<void> {
  if (!pageToken) {
    console.error('[meta-leads] no Page access token available — skipping batch');
    return;
  }
  const auditUserId = await resolveAuditUserId(db, accountId).catch(() => null);

  for (const value of values) {
    const leadgenId = value.leadgen_id;
    if (!leadgenId) continue;

    // Claim before working. A 23505 here means a concurrent delivery (or
    // an earlier one) already owns this lead.
    const { error: claimErr } = await db.from('meta_lead_events').insert({
      leadgen_id: leadgenId,
      account_id: accountId,
      page_id: value.page_id ?? null,
      form_id: value.form_id ?? null,
    });
    if (claimErr) {
      if (claimErr.code === '23505') {
        console.info(`[meta-leads] lead ${leadgenId} already processed — skipping`);
        continue;
      }
      // Bookkeeping failed for some other reason. Losing a real lead is
      // worse than processing it twice, so carry on.
      console.error('[meta-leads] claim insert failed, processing anyway:', claimErr);
    }

    try {
      const detail = await fetchLeadDetail(leadgenId, pageToken);
      const mapped = mapLeadFields(detail.field_data);
      if (!mapped.phone) {
        console.warn(`[meta-leads] lead ${leadgenId} has no phone — skipping`);
        continue;
      }

      const result = await captureLead(db, accountId, {
        phone: mapped.phone,
        name: mapped.name,
        email: mapped.email,
        lead_source: 'meta_ads',
        campaign_name: detail.campaign_name,
        ad_id: value.ad_id ?? detail.ad_id,
        utm_source: 'facebook',
        utm_medium: 'paid_social',
        utm_campaign: detail.campaign_name,
      });

      await db
        .from('meta_lead_events')
        .update({ contact_id: result.contactId })
        .eq('leadgen_id', leadgenId);

      // Custom form questions aren't contact columns — keep them verbatim
      // as a note so nothing the prospect answered is lost.
      if (mapped.extras.length > 0 && auditUserId) {
        const noteText =
          '📋 Meta Lead Ads — respuestas del formulario\n' +
          mapped.extras.map((e) => `- ${e.label}: ${e.value}`).join('\n');
        const { error } = await db.from('contact_notes').insert({
          contact_id: result.contactId,
          user_id: auditUserId,
          note_text: noteText,
        });
        if (error) console.error('[meta-leads] note insert failed:', error);
      }

      if (result.conversationCreated) {
        await dispatchWebhookEvent(db, accountId, 'conversation.created', {
          conversation_id: result.conversationId,
          contact_id: result.contactId,
        });
      }

      if (result.contactCreated) {
        await runAutomationsForTrigger({
          accountId,
          triggerType: 'new_contact_created',
          contactId: result.contactId,
          context: { conversation_id: result.conversationId },
        }).catch((err) =>
          console.error('[meta-leads] automation dispatch failed:', err),
        );
      }
    } catch (err) {
      console.error(`[meta-leads] failed to process lead ${leadgenId}:`, err);
      // Release the claim so Meta's next retry gets a fresh attempt.
      await db
        .from('meta_lead_events')
        .delete()
        .eq('leadgen_id', leadgenId)
        .is('contact_id', null);
    }
  }
}
