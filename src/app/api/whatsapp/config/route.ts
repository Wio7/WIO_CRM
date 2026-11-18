import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { LINE_AREAS, type WhatsAppLine } from '@/lib/whatsapp/lines'

// Fila de línea tal como se guarda; el token (y el de verificación) viven
// cifrados y NUNCA salen en la respuesta.
type LineRow = WhatsAppLine & {
  verify_token?: string | null
  registered_at?: string | null
  sort_order?: number | null
}
// Marca que se guarda (cifrada) en access_token al desconectar sin borrar la fila.
const DISCONNECTED_TOKEN = 'disconnected'

type PublicLine = Omit<LineRow, 'access_token' | 'verify_token'>

function toPublicLine(row: LineRow): PublicLine {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { access_token, verify_token, ...rest } = row
  return rest
}

/** Principal = la marcada; si ninguna lo está, la de menor sort_order. */
function pickPrimary<T extends { is_primary: boolean }>(lines: T[]): T | null {
  return lines.find((l) => l.is_primary) ?? lines[0] ?? null
}

async function readLines(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
) {
  const { data, error } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .order('sort_order', { ascending: true })
  return { lines: (data as LineRow[] | null) ?? [], error }
}

/**
 * Resolve the caller's account_id from their profile. Inlined here
 * (rather than going through `@/lib/auth/account.getCurrentAccount`)
 * because the GET handler wants to return shaped 200s for every
 * non-auth failure mode, not throw — keeping the helper minimal lets
 * the existing response branches stay as-is.
 *
 * Returns null if the user has no profile or no account; callers
 * should treat that the same as "not connected".
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

// Lazy-initialised service-role client. We need it to detect a
// phone_number_id already claimed by a *different* user — under RLS,
// the user's own session can't see other users' rows, so the conflict
// would be invisible without the service role.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * GET /api/whatsapp/config
 *
 * Used by the "Test API Connection" button and by the page to check
 * whether the saved config is healthy. Returns 200 in all non-auth cases
 * so the UI can render an appropriate message rather than show a 500.
 *
 * Response shape:
 *   { connected: true,  phone_info: {...} }
 *   { connected: false, reason: 'no_config',        message: '...' }
 *   { connected: false, reason: 'token_corrupted',  message: '...', needs_reset: true }
 *   { connected: false, reason: 'meta_api_error',   message: '...' }
 */
export async function GET() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_account',
          message: 'Your profile is not linked to an account.',
        },
        { status: 200 },
      )
    }

    const { lines: allLines, error: configError } = await readLines(supabase, accountId)

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 }
      )
    }

    const lines = allLines.map(toPublicLine)
    const config = pickPrimary(allLines)

    if (!config) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: 'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
          lines,
        },
        { status: 200 }
      )
    }

    // Try to decrypt the stored token with the current ENCRYPTION_KEY.
    // If this fails, the key changed (or was never consistent across envs).
    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch (err) {
      console.error('[whatsapp/config GET] Token decryption failed:', err)
      return NextResponse.json(
        {
          connected: false,
          reason: 'token_corrupted',
          needs_reset: true,
          message:
            'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or it differs between environments (local vs Hostinger vs Vercel). Click "Reset Configuration" below, then re-save.',
          lines,
        },
        { status: 200 }
      )
    }

    if (config.disconnected_at) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'line_disconnected',
          message: 'La línea principal está desconectada. Vuelve a conectar el número para usarla.',
          lines,
        },
        { status: 200 },
      )
    }

    // Validate credentials against Meta
    try {
      const phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
      return NextResponse.json({ connected: true, phone_info: phoneInfo, lines })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('[whatsapp/config GET] Meta API verification failed:', message)
      return NextResponse.json(
        {
          connected: false,
          reason: 'meta_api_error',
          message: `Meta API rejected the credentials: ${message}`,
          lines,
        },
        { status: 200 }
      )
    }
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Saves or updates the WhatsApp config for the authenticated user.
 * Verifies credentials with Meta first, then encrypts and stores.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const { phone_number_id, waba_id, access_token, verify_token, pin, line_id, line_name, area, logo_url, new_line } = body

    if (!access_token || !phone_number_id) {
      return NextResponse.json(
        { error: 'access_token and phone_number_id are required' },
        { status: 400 }
      )
    }

    if (pin !== undefined && pin !== null && pin !== '') {
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        return NextResponse.json(
          { error: 'PIN must be exactly 6 digits.' },
          { status: 400 }
        )
      }
    }

    // Datos opcionales de la línea. Se validan antes de llamar a Meta.
    if (line_id !== undefined && line_id !== null && typeof line_id !== 'string') {
      return NextResponse.json({ error: 'line_id must be a string.' }, { status: 400 })
    }
    if (new_line !== undefined && typeof new_line !== 'boolean') {
      return NextResponse.json({ error: 'new_line debe ser true o false.' }, { status: 400 })
    }
    if (new_line === true && line_id) {
      return NextResponse.json({ error: 'new_line y line_id son contradictorios: usa uno solo.' }, { status: 400 })
    }
    if (line_name !== undefined && (typeof line_name !== 'string' || !line_name.trim() || line_name.length > 80)) {
      return NextResponse.json({ error: 'line_name must be a non-empty string up to 80 characters.' }, { status: 400 })
    }
    if (area !== undefined && area !== null && area !== '' && !(LINE_AREAS as readonly string[]).includes(area)) {
      return NextResponse.json({ error: 'area is not a valid area.' }, { status: 400 })
    }
    if (logo_url !== undefined && logo_url !== null && typeof logo_url !== 'string') {
      return NextResponse.json({ error: 'logo_url must be a string.' }, { status: 400 })
    }

    // Reject if another account has already claimed this phone_number_id.
    // wacrm is single-tenant-per-WhatsApp-number — letting two accounts
    // bind the same number causes the webhook's `.single()` lookup to
    // throw PGRST116 ("multiple rows"), silently dropping every
    // inbound message. See issue #136. Post-multi-user we key on
    // account_id (not user_id) since teammates inside the same account
    // all share one config; the conflict is between accounts.
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phone_number_id)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('Error checking phone_number_id ownership:', claimedError)
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 }
      )
    }

    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one wacrm user.',
        },
        { status: 409 }
      )
    }

    // Verify credentials with Meta BEFORE saving
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: phone_number_id,
        accessToken: access_token,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('Meta API verification failed during save:', message)
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 400 }
      )
    }

    // Encrypt sensitive tokens before storing
    let encryptedAccessToken: string
    let encryptedVerifyToken: string | null
    try {
      encryptedAccessToken = encrypt(access_token)
      encryptedVerifyToken = verify_token ? encrypt(verify_token) : null
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 }
      )
    }

    // Líneas de la cuenta: con `line_id` se edita esa línea; sin él, la fila
    // de este mismo número (re-guardado) o, si el número es nuevo, se crea
    // una línea nueva (la primera de la cuenta queda como principal).
    const { lines: accountLines, error: linesError } = await readLines(supabase, accountId)
    if (linesError) {
      console.error('Error reading whatsapp_config lines:', linesError)
      return NextResponse.json({ error: 'Failed to read configuration' }, { status: 500 })
    }
    // Sin line_id: (a) mismo número -> esa línea; (b) 0 líneas -> crea la principal;
    // (c) 1 línea -> la reemplaza (cambio de número como antes); (d) 2+ y número
    // desconocido -> 400. Una línea adicional exige `new_line: true`.
    const sameNumberLine = accountLines.find((l) => l.phone_number_id === phone_number_id) ?? null
    let existing: LineRow | null
    if (line_id) {
      existing = accountLines.find((l) => l.id === line_id) ?? null
      if (!existing) return NextResponse.json({ error: 'Line not found.' }, { status: 404 })
    } else if (sameNumberLine) {
      existing = sameNumberLine
    } else if (new_line === true || accountLines.length === 0) {
      existing = null
    } else if (accountLines.length === 1) {
      existing = accountLines[0]
    } else {
      return NextResponse.json(
        { error: 'Esta cuenta tiene varias líneas de WhatsApp: indica cuál con line_id (o usa new_line: true para agregar una nueva).' },
        { status: 400 }
      )
    }

    // Otra línea de esta misma cuenta ya usa ese phone_number_id (UNIQUE global).
    if (sameNumberLine && existing && sameNumberLine.id !== existing.id) {
      return NextResponse.json(
        { error: 'Ese número ya está conectado como otra línea de esta cuenta.' },
        { status: 409 }
      )
    }

    // The form never shows the verify token back (same as the access
    // token), so it arrives empty on every later save — changing the PIN,
    // rotating the access token. Empty means "unchanged", not "clear it":
    // clearing it silently breaks the webhook the next time Meta
    // re-verifies, long after whoever saved has forgotten touching it.
    // Una línea nueva hereda el de la principal (el webhook es de la app).
    const inheritedVerifyToken = existing?.verify_token ?? pickPrimary(accountLines)?.verify_token ?? null
    if (!encryptedVerifyToken && inheritedVerifyToken) {
      encryptedVerifyToken = inheritedVerifyToken as string
    }

    const sameNumber =
      existing?.phone_number_id === phone_number_id &&
      existing?.registered_at != null

    // Step 1: register the phone number for inbound webhooks.
    //
    // Attempted on first save AND whenever the user supplies a fresh
    // PIN (e.g. they rotated the 2FA PIN in Meta Manager). Skipped
    // when the same number is already registered and no PIN was
    // supplied — re-registering an already-active number with a
    // stale PIN would actually fail and undo the active subscription.
    let registeredAt: string | null = existing?.registered_at ?? null
    let registrationError: string | null = null
    // True when registration was deliberately skipped because no PIN
    // was supplied (see below). Distinct from registrationError — this
    // is not a failure, just an incomplete-but-valid save.
    let registrationSkipped = false

    const needsRegistration = !sameNumber || (typeof pin === 'string' && pin.length > 0)
    if (needsRegistration) {
      if (!pin) {
        // No PIN provided. Meta TEST numbers (Developer Console) are
        // pre-registered by Meta and expose no two-step verification
        // PIN to set, so requiring one made them impossible to connect
        // (issue #242). The /register + PIN step only matters for
        // production numbers under a shared WABA (issue #136), so treat
        // it as best-effort: skip it, save the (already Meta-verified)
        // credentials as connected, and leave registered_at null. The
        // UI surfaces a separate "Not registered" banner with a path to
        // add a PIN later for users who do need inbound webhook routing.
        registrationSkipped = true
      } else {
        try {
          await registerPhoneNumber({
            phoneNumberId: phone_number_id,
            accessToken: access_token,
            pin,
          })
          registeredAt = new Date().toISOString()
        } catch (err) {
          registrationError =
            err instanceof Error ? err.message : 'Unknown Meta API error'
          console.error('Phone number /register failed:', registrationError)
          // We deliberately fall through and still save the row so the
          // user can retry without re-entering everything. The UI
          // surfaces `last_registration_error` so they see WHY it's
          // not actually live yet.
        }
      }
    }

    // Step 2: subscribe the WABA to this app. Idempotent on Meta's
    // side, so we call on every save and persist the timestamp.
    // Skipped only when there's no waba_id (legacy rows from before
    // we required it).
    let subscribedAppsAt: string | null = null
    if (waba_id) {
      try {
        await subscribeWabaToApp({
          wabaId: waba_id,
          accessToken: access_token,
        })
        subscribedAppsAt = new Date().toISOString()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn('WABA subscribed_apps failed (non-fatal):', message)
        // Subscription failures are rare once the App has the right
        // permissions; we don't block save on them — the diagnostic
        // endpoint surfaces this state too.
      }
    }

    // Persist everything in one shot. If /register failed we still
    // store the credentials and the error so the UI can guide the
    // user through a retry.
    const baseRow = {
      phone_number_id,
      waba_id: waba_id || null,
      access_token: encryptedAccessToken,
      verify_token: encryptedVerifyToken,
      status: registrationError ? 'disconnected' : 'connected',
      disconnected_at: null, // reconectar reactiva una línea desconectada en suave
      connected_at: registrationError ? null : new Date().toISOString(),
      registered_at: registrationError ? null : registeredAt,
      subscribed_apps_at: subscribedAppsAt ?? null,
      last_registration_error: registrationError,
      updated_at: new Date().toISOString(),
    }

    const lineMeta = {
      ...(line_name !== undefined ? { line_name: line_name.trim() } : {}),
      ...(area !== undefined ? { area: area === '' ? null : area } : {}),
      ...(logo_url !== undefined ? { logo_url: logo_url || null } : {}),
    } as { line_name?: string; area?: string | null; logo_url?: string | null }

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update({ ...baseRow, ...lineMeta })
        .eq('id', existing.id)
        .eq('account_id', accountId)

      if (updateError) {
        if (updateError.code === '23505') {
          return NextResponse.json({ error: 'Ese número ya está conectado como otra línea.' }, { status: 409 })
        }
        console.error('Error updating whatsapp_config:', updateError)
        return NextResponse.json(
          { error: 'Failed to update configuration' },
          { status: 500 }
        )
      }
    } else {
      // Insert with both columns: `account_id` is the tenancy key
      // (NOT NULL post-017; desde la 103 ya no es único: una
      // cuenta tiene varias líneas), `user_id` is the audit column identifying which
      // member of the account saved the config.
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({
          account_id: accountId,
          user_id: user.id,
          ...baseRow,
          line_name: lineMeta.line_name ?? (accountLines.length === 0 ? 'Principal' : `Línea ${accountLines.length + 1}`),
          area: lineMeta.area ?? null,
          logo_url: lineMeta.logo_url ?? null,
          is_primary: accountLines.length === 0,
          sort_order: accountLines.reduce((max, l) => Math.max(max, l.sort_order ?? 0), -1) + 1,
        })

      if (insertError) {
        if (insertError.code === '23505') {
          return NextResponse.json({ error: 'Ese número ya está conectado como otra línea.' }, { status: 409 })
        }
        console.error('Error inserting whatsapp_config:', insertError)
        return NextResponse.json(
          { error: 'Failed to save configuration' },
          { status: 500 }
        )
      }
    }

    if (registrationError) {
      // Save succeeded but the number isn't actually live. Return
      // 200 with a structured error so the UI can show the specific
      // remediation step instead of a generic toast.
      return NextResponse.json({
        success: false,
        saved: true,
        registered: false,
        registration_error: registrationError,
        phone_info: phoneInfo,
      })
    }

    return NextResponse.json({
      success: true,
      saved: true,
      registered: registeredAt != null,
      // Credentials are valid and saved, but inbound webhook
      // registration was skipped because no PIN was supplied (e.g. a
      // Meta test number). The UI shows the "Not registered" banner
      // rather than claiming the number is fully live.
      registration_skipped: registrationSkipped,
      phone_info: phoneInfo,
    })
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/config[?line_id=...]
 *
 * Desconecta (borra) UNA línea de la cuenta. Sin `line_id` actúa sobre la
 * principal (como el botón "Reset Configuration"). Las conversaciones no se
 * borran: conversations.line_id pasa a NULL (ON DELETE SET NULL). Si la línea
 * borrada era la principal y quedan otras, la de menor sort_order pasa a
 * principal. Borrar la última línea está permitido.
 */
export async function DELETE(request?: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    let lineId: string | null = null
    if (request) {
      lineId = new URL(request.url).searchParams.get('line_id')
      if (!lineId) {
        const body = await request.json().catch(() => null)
        if (typeof body?.line_id === 'string') lineId = body.line_id
      }
    }

    const { lines, error: readError } = await readLines(supabase, accountId)
    if (readError) {
      console.error('Error reading whatsapp_config lines:', readError)
      return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 })
    }
    const target = lineId ? lines.find((l) => l.id === lineId) ?? null : pickPrimary(lines)
    if (lineId && !target) {
      return NextResponse.json({ error: 'Line not found.' }, { status: 404 })
    }
    if (!target) return NextResponse.json({ success: true })

    // Cuántas conversaciones cuelgan de la línea. Si hay, la fila NO se borra:
    // line_id NULL significa "línea principal", así que borrarla movería esos
    // hilos al otro número sin avisar. Se desconecta (suave) y se invalida el token.
    const { count: convCount, error: convError } = await supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('line_id', target.id)
    if (convError) {
      console.error('Error counting line conversations:', convError)
      return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 })
    }
    const conversationCount = convCount ?? 0
    const soft = conversationCount > 0
    const others = lines.filter((l) => l.id !== target.id)
    const nextPrimary =
      others.find((l) => !l.disconnected_at) ?? (soft ? null : others[0] ?? null)
    const handOver = target.is_primary && nextPrimary !== null

    if (soft) {
      const { error: softError } = await supabase
        .from('whatsapp_config')
        .update({
          status: 'disconnected',
          disconnected_at: new Date().toISOString(),
          access_token: encrypt(DISCONNECTED_TOKEN),
          connected_at: null,
          updated_at: new Date().toISOString(),
          ...(handOver ? { is_primary: false } : {}),
        })
        .eq('id', target.id)
        .eq('account_id', accountId)
      if (softError) {
        console.error('Error disconnecting whatsapp_config:', softError)
        return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 })
      }
    } else {
      const { error: deleteError } = await supabase
        .from('whatsapp_config')
        .delete()
        .eq('id', target.id)
        .eq('account_id', accountId)
      if (deleteError) {
        console.error('Error deleting whatsapp_config:', deleteError)
        return NextResponse.json(
          { error: 'Failed to delete configuration' },
          { status: 500 }
        )
      }
    }

    // Si era la principal, otra línea (conectada y de menor sort_order) pasa a serlo.
    // La anterior ya dejó de serlo (o se borró): el índice parcial nunca ve dos.
    if (handOver && nextPrimary) {
      const { error: promoteError } = await supabase
        .from('whatsapp_config')
        .update({ is_primary: true })
        .eq('id', nextPrimary.id)
        .eq('account_id', accountId)
      if (promoteError) {
        console.error('Error promoting primary whatsapp line:', promoteError)
        return NextResponse.json(
          { error: 'Line removed but a new primary line could not be set' },
          { status: 500 }
        )
      }
    }

    if (soft) {
      return NextResponse.json({
        success: true,
        disconnected: true,
        conversation_count: conversationCount,
        warning: `La línea tiene ${conversationCount} conversación(es), así que no se borró: quedó desconectada y no puede enviar mensajes. Sus conversaciones se conservan; para volver a usarla, conecta de nuevo el mismo número.`,
      })
    }
    return NextResponse.json({ success: true, conversation_count: 0 })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
