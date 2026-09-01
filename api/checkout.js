// Vercel Serverless Function — /api/checkout
// GET  → readiness probe: { ready, provider } (register.html hides its banner when ready)
// POST → validate, save a PENDING registration to Firestore, then create a hosted
//        checkout session with the ACTIVE provider (Stripe or Square) and return { url }.
//
// Provider-agnostic: flip PAYMENT_PROVIDER between "stripe" and "square" — nothing
// else changes. Both adapters use fetch (no SDK / no build step).
//
// Env (Vercel project settings — never in code):
//   PAYMENT_PROVIDER          "stripe" | "square"
//   Stripe:  STRIPE_SECRET_KEY
//   Square:  SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENVIRONMENT ("sandbox"|"production")
//   Firestore: FIREBASE_PROJECT_ID, FIREBASE_API_KEY, FB_ADMIN_EMAIL, FB_ADMIN_PASSWORD
//   Optional: SITE_URL (e.g. https://www.downerbasketballacademy.com) for redirect links

import { fbConfigured, fbAdminConfigured, fsCreate, fsPatch, fsPatchVerified } from './_firestore.js';
import { normalizeRegistration, expectedCents, CLINIC } from './_clinic.js';

const PROVIDER = (process.env.PAYMENT_PROVIDER || '').toLowerCase();

function stripeReady() { return !!process.env.STRIPE_SECRET_KEY; }
function squareReady() { return !!(process.env.SQUARE_ACCESS_TOKEN && process.env.SQUARE_LOCATION_ID); }
function providerReady() {
  if (PROVIDER === 'stripe') return stripeReady();
  if (PROVIDER === 'square') return squareReady();
  return false;
}
function ready() { return providerReady() && fbConfigured() && fbAdminConfigured(); }

function baseUrl(req) {
  if (process.env.SITE_URL) return String(process.env.SITE_URL).replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function summarize(reg) {
  const who = reg.player_count === 1 ? reg.players[0].first : `${reg.player_count} players`;
  const what = reg.all_six ? 'all 6 sessions' : `${reg.session_count} session${reg.session_count > 1 ? 's' : ''}`;
  return `${CLINIC.title} — ${what} for ${who}`;
}

// ── Stripe hosted Checkout Session ───────────────────────────────────────
async function createStripeCheckout({ regId, reg, cents, base }) {
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', `${base}/register-success.html?rid=${regId}&provider=stripe`);
  params.set('cancel_url', `${base}/register.html`);
  params.set('customer_email', reg.parent_email);
  params.set('client_reference_id', regId);
  params.set('metadata[rid]', regId);
  params.set('payment_intent_data[metadata][rid]', regId);
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', 'usd');
  params.set('line_items[0][price_data][unit_amount]', String(cents));
  params.set('line_items[0][price_data][product_data][name]', summarize(reg).slice(0, 240));

  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const d = await r.json();
  if (!r.ok || !d.url) throw new Error('stripe: ' + ((d.error && d.error.message) || ('http ' + r.status)));
  return { url: d.url, patch: { stripe_session_id: d.id, stripe_payment_intent: d.payment_intent || '' } };
}

// ── Square hosted Payment Link ───────────────────────────────────────────
async function createSquareCheckout({ regId, reg, cents, base }) {
  const ENV = (process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();
  const API = ENV === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
  const r = await fetch(`${API}/v2/online-checkout/payment-links`, {
    method: 'POST',
    headers: {
      'Square-Version': '2024-10-17',
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      idempotency_key: ('dba_' + regId).slice(0, 45),
      quick_pay: {
        name: summarize(reg).slice(0, 250),
        price_money: { amount: cents, currency: 'USD' },
        location_id: process.env.SQUARE_LOCATION_ID,
      },
      checkout_options: {
        redirect_url: `${base}/register-success.html?rid=${regId}&provider=square`,
        ask_for_shipping_address: false,
      },
      pre_populated_data: { buyer_email: reg.parent_email },
    }),
  });
  const d = await r.json();
  const link = d && d.payment_link;
  if (!r.ok || !link || !link.url) throw new Error('square: ' + ((d.errors && d.errors[0] && (d.errors[0].detail || d.errors[0].code)) || ('http ' + r.status)));
  return { url: link.url, patch: { square_link_id: link.id || '', square_order_id: link.order_id || '' } };
}

export default async function handler(req, res) {
  // Same-origin only — no CORS headers, so another site can't drive this
  // state-changing endpoint (it creates registrations + provider sessions once live).
  if (req.method === 'GET') return res.status(200).json({ ready: ready(), provider: PROVIDER || null });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // Validate + sanitize (rejects tampered/incomplete data).
  const norm = normalizeRegistration(req.body || {});
  if (!norm.ok) return res.status(400).json({ error: norm.error });
  const reg = norm.reg;

  // Authoritative price — never trust the browser.
  const cents = expectedCents(reg);
  if (cents <= 0) return res.status(400).json({ error: 'nothing_to_charge' });

  // If payments/DB aren't wired yet, tell the page so it shows "opens soon".
  if (!ready()) return res.status(503).json({ error: 'not_configured' });

  // 1) Persist a PENDING registration so we have a record even if the parent
  //    abandons checkout (and so the admin can see incomplete attempts).
  const now = new Date().toISOString();
  const created = await fsCreate('registrations', Object.assign({}, reg, {
    status: 'pending',
    payment_provider: PROVIDER,
    amount_cents: cents,
    amount_refunded_cents: 0,
    currency: 'USD',
    waiver_at: now,
    waiver_ip: String((req.headers['x-forwarded-for'] || '').split(',')[0] || '').slice(0, 60),
    created: now,
  }));
  const regId = created && created.name ? String(created.name).split('/').pop() : null;
  if (!regId) return res.status(500).json({ error: 'save_failed' });

  // 2) Create the hosted checkout with the active provider.
  try {
    const base = baseUrl(req);
    const out = PROVIDER === 'stripe'
      ? await createStripeCheckout({ regId, reg, cents, base })
      : await createSquareCheckout({ regId, reg, cents, base });
    // MONEY-CRITICAL: the provider session/order id is the ONLY key confirm + reconcile
    // use to match a real payment back to this record. Persist it with a verified,
    // retried write BEFORE giving out the checkout URL — and fail closed if it can't be
    // stored, so we never let someone pay against a record we could never reconcile.
    const w = await fsPatchVerified(`registrations/${regId}`, out.patch || {});
    if (!w.ok) {
      await fsPatch(`registrations/${regId}`, { status: 'error', error_detail: 'link_persist_failed' });
      return res.status(503).json({ error: 'checkout_unavailable' });
    }
    return res.status(200).json({ url: out.url, rid: regId });
  } catch (e) {
    await fsPatch(`registrations/${regId}`, { status: 'error', error_detail: String(e.message || e).slice(0, 300) });
    return res.status(502).json({ error: 'checkout_failed', detail: String(e.message || e) });
  }
}
