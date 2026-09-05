import crypto from 'node:crypto'

// ============================================================
// Validate the `X-Twilio-Signature` header on inbound webhooks.
//
// Twilio signs each request by concatenating the full URL with every
// POST parameter — sorted by key, appended as key+value with no
// separators — then HMAC-SHA1 with the account's Auth Token, base64.
//
//   https://www.twilio.com/docs/usage/security#validating-requests
//
// Without this, anyone who learns a webhook URL can POST fabricated
// call results: mark calls answered, corrupt the queue, or inject
// recording URLs we would then fetch. Fails closed, same posture as
// verifyMetaWebhookSignature (src/lib/whatsapp/webhook-signature.ts).
//
// Unlike Meta's global META_APP_SECRET, the signing key here is
// per-account (each tenant brings its own Twilio credentials), so the
// caller resolves the account first and passes the token in.
// ============================================================

/**
 * @param url       The exact public URL Twilio requested, including
 *                  query string. Must match byte-for-byte what Twilio
 *                  used, or the HMAC won't agree — behind a proxy that
 *                  rewrites the host, derive it the same way the
 *                  webhook URL was configured.
 * @param params    The parsed form-encoded POST body.
 * @param signature The `X-Twilio-Signature` header value.
 * @param authToken The account's decrypted Twilio Auth Token.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null,
  authToken: string | null,
): boolean {
  if (!authToken) {
    console.error(
      '[twilio] no auth token available — rejecting webhook. ' +
        'Configure Twilio credentials in Settings → Marcador.',
    )
    return false
  }
  if (!signature) return false

  // Sorted key + value, concatenated onto the URL with no separators.
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url)

  const expected = crypto
    .createHmac('sha1', authToken)
    .update(Buffer.from(payload, 'utf-8'))
    .digest('base64')

  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  // Bail if lengths differ — timingSafeEqual throws otherwise.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Read a Twilio webhook body once, returning both the parsed params
 * (for signature verification and handling) and nothing else — the raw
 * text isn't needed because Twilio signs the parsed pairs, not the
 * byte stream. Request bodies can only be consumed once, so every
 * webhook route should call this exactly once and pass the result on.
 */
export async function parseTwilioForm(
  request: Request,
): Promise<Record<string, string>> {
  const text = await request.text()
  const params: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(text)) {
    params[key] = value
  }
  return params
}
