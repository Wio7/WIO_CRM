// ============================================================
// Meta Lead Ads webhook — SHARED app (WIO.CRM).
//
// Counterpart to /api/meta/leads/[token] (own-app path). Because every
// tenant authorizes the same Meta App, Meta delivers all of their leads
// to this one callback. There's no token in the URL to tell us who a
// delivery belongs to, so we resolve the account from the event's
// `page_id` via `meta_pages` — which is exactly why page_id carries a
// GLOBAL unique index (migration 037).
//
//   GET  — Meta's subscription verification challenge, checked against
//          META_WEBHOOK_VERIFY_TOKEN.
//   POST — `leadgen` delivery: verify the HMAC with the app-level
//          META_APP_SECRET, group events by page, resolve each page to
//          its account, and hand off to the shared processor.
//
// Deliveries for pages we don't know (someone connected a page and then
// disconnected, or another app's traffic) are acknowledged and dropped
// silently — 200 so Meta stops retrying, no work done.
// ============================================================

import { NextResponse, after } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  processLeadgenValues,
  type LeadgenValue,
} from '@/lib/meta-leads/process-lead';

// ------------------------------------------------------------
// GET — subscription verification.
// ------------------------------------------------------------
export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const verifyToken = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!expected) {
    console.error('[meta webhook] META_WEBHOOK_VERIFY_TOKEN is not configured');
    return new NextResponse('Forbidden', { status: 403 });
  }

  if (mode === 'subscribe' && verifyToken === expected) {
    // Meta wants the raw challenge echoed back verbatim.
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
export async function POST(request: Request) {
  // Raw body first — the HMAC is computed over the exact bytes.
  const rawBody = await request.text();

  const signature = request.headers.get('x-hub-signature-256');
  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    return new NextResponse('Invalid signature', { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse('Bad request', { status: 400 });
  }

  const body = payload as {
    object?: string;
    entry?: { id?: string; changes?: { field?: string; value?: LeadgenValue }[] }[];
  };

  // Group by page so one Graph token lookup covers all of that page's
  // events in the delivery.
  const byPage = new Map<string, LeadgenValue[]>();
  if (body?.object === 'page' && Array.isArray(body.entry)) {
    for (const entry of body.entry) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'leadgen' || !change.value?.leadgen_id) continue;
        // `entry.id` is the page id; the change value usually repeats it.
        const pageId = change.value.page_id ?? entry.id;
        if (!pageId) continue;
        const list = byPage.get(pageId) ?? [];
        list.push({ ...change.value, page_id: pageId });
        byPage.set(pageId, list);
      }
    }
  }

  if (byPage.size > 0) {
    after(
      routeAndProcess(byPage).catch((err) =>
        console.error('[meta webhook] processing failed:', err),
      ),
    );
  }

  return NextResponse.json({ received: true });
}

/**
 * Resolve each page to its owning account and run the shared processor.
 * Only pages the admin actually switched on (`is_active`) ingest leads —
 * connecting Facebook lists every page the user manages, but silence is
 * the default until they opt a page in.
 */
async function routeAndProcess(byPage: Map<string, LeadgenValue[]>): Promise<void> {
  const db = supabaseAdmin();

  for (const [pageId, values] of byPage) {
    const { data: page, error } = await db
      .from('meta_pages')
      .select('account_id, page_access_token, is_active')
      .eq('page_id', pageId)
      .maybeSingle();

    if (error) {
      console.error('[meta webhook] page lookup failed:', pageId, error);
      continue;
    }
    if (!page) {
      console.info(`[meta webhook] page ${pageId} is not connected — ignoring`);
      continue;
    }
    if (!page.is_active) {
      console.info(`[meta webhook] page ${pageId} is paused — ignoring`);
      continue;
    }

    let pageToken: string | null = null;
    if (page.page_access_token) {
      try {
        pageToken = decrypt(page.page_access_token);
      } catch (err) {
        console.error('[meta webhook] page token decryption failed:', pageId, err);
      }
    }

    await processLeadgenValues(db, page.account_id, pageToken, values);
  }
}
