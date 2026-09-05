// ============================================================
// One-time setup: subscribe the WIO.CRM Meta App to `leadgen` webhooks.
//
// This is the app-level half of Lead Ads delivery. The other half is
// per-page (POST /{page_id}/subscribed_apps), which the CRM does itself
// when an admin flips a page on in Settings → Meta Lead Ads. Both must be
// in place before Meta sends anything.
//
// Doing it here rather than clicking through the App Dashboard keeps the
// callback URL and verify token in version control alongside the route
// that consumes them.
//
// Usage (from the wacrm directory):
//
//   node --env-file=.env.local scripts/setup-meta-webhook.mjs
//   node --env-file=.env.local scripts/setup-meta-webhook.mjs --list
//
// Requires META_APP_ID, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, and
// a public callback base (NEXT_PUBLIC_SITE_URL, or --url=<https://...>).
// ============================================================

const API_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${API_VERSION}`;

const APP_ID = process.env.META_APP_ID;
const APP_SECRET = process.env.META_APP_SECRET;
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;

const urlArg = process.argv.find((a) => a.startsWith('--url='));
const BASE_URL = (urlArg ? urlArg.slice('--url='.length) : process.env.NEXT_PUBLIC_SITE_URL)
  ?.replace(/\/+$/, '');

const listOnly = process.argv.includes('--list');

function bail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

if (!APP_ID) bail('META_APP_ID no está definido.');
if (!APP_SECRET) bail('META_APP_SECRET no está definido.');
if (!listOnly && !VERIFY_TOKEN) {
  bail(
    'META_WEBHOOK_VERIFY_TOKEN no está definido.\n' +
      '  Genera uno con: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"\n' +
      '  y agrégalo a .env.local y a Vercel.',
  );
}
if (!listOnly && !BASE_URL) {
  bail('Define NEXT_PUBLIC_SITE_URL o pasa --url=https://tu-dominio.com');
}
if (!listOnly && !BASE_URL.startsWith('https://')) {
  bail(`Meta exige HTTPS para el callback. Recibido: ${BASE_URL}`);
}

const appAccessToken = `${APP_ID}|${APP_SECRET}`;
const callbackUrl = BASE_URL ? `${BASE_URL}/api/meta/webhook` : null;

async function listSubscriptions() {
  const res = await fetch(
    `${GRAPH}/${APP_ID}/subscriptions?access_token=${encodeURIComponent(appAccessToken)}`,
  );
  const json = await res.json();
  if (!res.ok || json.error) {
    bail(`No se pudieron listar las suscripciones: ${json.error?.message ?? res.status}`);
  }
  return json.data ?? [];
}

async function subscribe() {
  const res = await fetch(`${GRAPH}/${APP_ID}/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      object: 'page',
      callback_url: callbackUrl,
      fields: 'leadgen',
      verify_token: VERIFY_TOKEN,
      include_values: 'true',
      access_token: appAccessToken,
    }),
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    // Meta calls the endpoint during this request; a failure here almost
    // always means the challenge didn't come back correctly.
    bail(
      `Meta rechazó la suscripción: ${json.error?.message ?? res.status}\n` +
        '  Causas típicas:\n' +
        `    · ${callbackUrl} no está desplegado todavía\n` +
        '    · META_WEBHOOK_VERIFY_TOKEN difiere entre este script y el servidor\n' +
        '    · El deploy no tiene la variable configurada en Vercel',
    );
  }
  return json;
}

console.log(`\nApp: ${APP_ID}`);

const before = await listSubscriptions();
if (before.length === 0) {
  console.log('Suscripciones actuales: ninguna');
} else {
  for (const sub of before) {
    console.log(`Suscripción actual: object=${sub.object} → ${sub.callback_url}`);
    for (const f of sub.fields ?? []) {
      console.log(`   · ${typeof f === 'string' ? f : f.name}`);
    }
  }
}

if (listOnly) {
  console.log('');
  process.exit(0);
}

console.log(`\nSuscribiendo 'leadgen' → ${callbackUrl} ...`);
await subscribe();
console.log('✓ Suscripción creada.\n');

const after = await listSubscriptions();
for (const sub of after) {
  if (sub.object !== 'page') continue;
  const fields = (sub.fields ?? []).map((f) => (typeof f === 'string' ? f : f.name));
  console.log(`  object=page → ${sub.callback_url}`);
  console.log(`  campos: ${fields.join(', ') || '(ninguno)'}`);
  console.log(`  activo: ${sub.active !== false ? 'sí' : 'no'}`);
}

console.log(
  '\nSiguiente paso: en el CRM, Configuración → Meta Lead Ads → Conectar con\n' +
    'Facebook, y activa las páginas que deban enviar leads.\n',
);
