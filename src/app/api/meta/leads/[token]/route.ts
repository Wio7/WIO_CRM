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
import {
  processLeadgenValues,
  type LeadgenValue,
} from '@/lib/meta-leads/process-lead';

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
      processLeadgenValues(
        db,
        config.account_id,
        pageToken,
        leadgenValues
      ).catch((err) => console.error('[meta-leads] processing failed:', err))
    );
  }

  return NextResponse.json({ received: true });
}
