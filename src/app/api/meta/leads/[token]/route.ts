// ============================================================
// Meta Lead Ads webhook — per-account, keyed by an unguessable token in
// the path (see migration 036).
//
//   GET  /api/meta/leads/{token}  — Meta's subscription verification
//                                   challenge (hub.mode/verify_token).
//   POST /api/meta/leads/{token}  — `leadgen` delivery: verify the HMAC
//                                   signature with the account's App
//                                   Secret, fetch the lead's answers from
//                                   the Graph API with the Page token, map
//                                   fields, create the contact (with
//                                   attribution) + conversation, and fire
//                                   `new_contact_created` so the
//                                   round-robin assigns an advisor.
//
// The token in the path resolves which account (and thus which secrets)
// a delivery belongs to — so multiple accounts can each bring their own
// Meta App to one deployment.
// ============================================================

import { NextResponse, after } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  getConfigByToken,
  decryptAppSecret,
  decryptPageToken,
  verifySignatureWithSecret,
} from '@/lib/meta-leads/config';
import { fetchLeadDetail } from '@/lib/meta-leads/graph';
import { mapLeadFields } from '@/lib/meta-leads/map-fields';
import { captureLead } from '@/lib/api/v1/leads';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';

// ------------------------------------------------------------
// GET — Meta subscription verification challenge.
// ------------------------------------------------------------
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const verifyToken = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  const config = await getConfigByToken(supabaseAdmin(), token);
  if (
    config &&
    config.is_active &&
    mode === 'subscribe' &&
    config.verify_token &&
    verifyToken === config.verify_token
  ) {
    // Meta expects the raw challenge string echoed back verbatim.
    return new NextResponse(challenge ?? '', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
  return new NextResponse('Forbidden', { status: 403 });
}

// ------------------------------------------------------------
// POST — leadgen delivery.
// ------------------------------------------------------------
interface LeadgenValue {
  leadgen_id?: string;
  page_id?: string;
  form_id?: string;
  ad_id?: string;
  created_time?: number;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  // Raw body is required for the HMAC check — read it before parsing.
  const rawBody = await request.text();

  const db = supabaseAdmin();
  const config = await getConfigByToken(db, token);
  if (!config) {
    return new NextResponse('Not found', { status: 404 });
  }
  if (!config.is_active) {
    // Known but paused — accept so Meta doesn't retry, but do nothing.
    return NextResponse.json({ received: true });
  }

  // Verify the signature with THIS account's App Secret. Fail closed.
  const signature = request.headers.get('x-hub-signature-256');
  const appSecret = decryptAppSecret(config);
  if (!verifySignatureWithSecret(rawBody, signature, appSecret)) {
    return new NextResponse('Invalid signature', { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse('Bad request', { status: 400 });
  }

  // Collect every leadgen change across entries.
  const leadgenValues: LeadgenValue[] = [];
  const body = payload as {
    object?: string;
    entry?: { changes?: { field?: string; value?: LeadgenValue }[] }[];
  };
  if (body?.object === 'page' && Array.isArray(body.entry)) {
    for (const entry of body.entry) {
      for (const change of entry.changes ?? []) {
        if (change.field === 'leadgen' && change.value?.leadgen_id) {
          leadgenValues.push(change.value);
        }
      }
    }
  }

  // Acknowledge fast; do the Graph fetch + contact creation after the
  // response so a slow Graph call can't make Meta time out and retry.
  if (leadgenValues.length > 0) {
    const pageToken = decryptPageToken(config);
    after(
      processLeads(config.account_id, pageToken, leadgenValues).catch((err) =>
        console.error('[meta-leads] processing failed:', err)
      )
    );
  }

  return NextResponse.json({ received: true });
}

/**
 * Fetch, map, and persist each lead. Best-effort per lead — one failure
 * never blocks the rest. Runs after the 200 response via `after()`.
 */
async function processLeads(
  accountId: string,
  pageToken: string | null,
  values: LeadgenValue[]
): Promise<void> {
  if (!pageToken) {
    console.error('[meta-leads] no Page access token configured — skipping');
    return;
  }
  const db = supabaseAdmin();
  const auditUserId = await resolveAuditUserId(db, accountId).catch(() => null);

  for (const value of values) {
    try {
      const detail = await fetchLeadDetail(value.leadgen_id!, pageToken);
      const mapped = mapLeadFields(detail.field_data);
      if (!mapped.phone) {
        console.warn(
          `[meta-leads] lead ${value.leadgen_id} has no phone — skipping`
        );
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

      // Preserve any custom form answers as a note so nothing is lost.
      if (mapped.extras.length > 0 && auditUserId) {
        const noteText =
          '📋 Meta Lead Ads — respuestas del formulario\n' +
          mapped.extras.map((e) => `- ${e.label}: ${e.value}`).join('\n');
        await db
          .from('contact_notes')
          .insert({
            contact_id: result.contactId,
            user_id: auditUserId,
            note_text: noteText,
          })
          .then(({ error }) => {
            if (error) console.error('[meta-leads] note insert failed:', error);
          });
      }

      if (result.conversationCreated) {
        await dispatchWebhookEvent(db, accountId, 'conversation.created', {
          conversation_id: result.conversationId,
          contact_id: result.contactId,
        });
      }

      // Fire new_contact_created for new contacts → runs the round-robin
      // advisor assignment on the campaign lead.
      if (result.contactCreated) {
        await runAutomationsForTrigger({
          accountId,
          triggerType: 'new_contact_created',
          contactId: result.contactId,
          context: { conversation_id: result.conversationId },
        }).catch((err) =>
          console.error('[meta-leads] automation dispatch failed:', err)
        );
      }
    } catch (err) {
      console.error(
        `[meta-leads] failed to process lead ${value.leadgen_id}:`,
        err
      );
    }
  }
}
