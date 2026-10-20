// Vercel Serverless Function — /api/pledge   (public, same-origin)
// The donor-facing side of the Shoot-a-Thon. No admin auth.
//
//   GET  /api/pledge              → public config + live totals for donate.html (the form + thermometer)
//   GET  /api/pledge?info=<id>    → a SAFE summary of one pledge (amount, player, status) for the pay page
//   GET  /api/pledge?pay=<id>     → mint a FRESH hosted checkout session and 302 to it
//   POST /api/pledge              → record a PLEDGE (no card, no charge); status 'pledged'
//
// Why "pay" mints fresh: hosted checkout sessions expire within ~24h, but a pay-link email
// may sit in an inbox for days. So the emailed link points HERE (a durable URL keyed by the
// pledge's unguessable Firestore id) and a new session is created at click-time — always valid.
// The authoritative amount is read from the pledge record (set by the admin at send-time), never
// from the browser. Same capability-token model as the clinic's register-success?rid=<id>.

import { fbConfigured, fbAdminConfigured, fsGet, fsCreate, fsQuery, fsPatch } from './_firestore.js';
import { SHOOTATHON, normalizePledge, pledgeDescription } from './_shootathon.js';
import { sendMail, buildPledgeEmail, emailConfigured, ADMIN_EMAIL } from './_email.js';

const PROVIDER = (process.env.PAYMENT_PROVIDER || '').toLowerCase();
function stripeReady() { return !!process.env.STRIPE_SECRET_KEY; }
function squareReady() { return !!(process.env.SQUARE_ACCESS_TOKEN && process.env.SQUARE_LOCATION_ID); }
function providerReady() {
  if (PROVIDER === 'stripe') return stripeReady();
  if (PROVIDER === 'square') return squareReady();
  return false;
}

function baseUrl(req) {
  if (process.env.SITE_URL) return String(process.env.SITE_URL).replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
function safeId(id) { return /^[A-Za-z0-9_-]{1,128}$/.test(String(id || '')); }
function redirect(res, url) { res.statusCode = 302; res.setHeader('Location', url); res.setHeader('Cache-Control', 'no-store'); return res.end(); }

async function loadEvent() { return (await fsGet(`shootathon/${SHOOTATHON.eventId}`)) || null; }
function playerName(event, slug) {
  const p = ((event && event.players) || []).find((x) => x.slug === slug);
  return p ? p.name : '';
}
function makesFor(event, slug) {
  const p = ((event && event.players) || []).find((x) => x.slug === slug);
  return p ? (p.makes || 0) : 0;
}
// "Adam Miller" → "Adam M." for tasteful social-proof display (never a full last name).
function firstNameLastInitial(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'A supporter';
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

// ── Hosted checkout for a donation (mints at click-time; supports either provider) ──
async function createDonationCheckout({ pledgeId, amountCents, playerName: pn, donorEmail, base }) {
  const name = pn ? `Shoot-a-Thon donation — backing ${pn}` : 'Shoot-a-Thon donation';
  if (PROVIDER === 'square') {
    const ENV = (process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();
    const API = ENV === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
    const r = await fetch(`${API}/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers: { 'Square-Version': '2024-10-17', Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotency_key: ('don_' + pledgeId + '_' + Date.now()).slice(0, 45),
        quick_pay: { name: name.slice(0, 250), price_money: { amount: amountCents, currency: 'USD' }, location_id: process.env.SQUARE_LOCATION_ID },
        checkout_options: { redirect_url: `${base}/donate-success.html?pledge=${pledgeId}`, ask_for_shipping_address: false },
        pre_populated_data: { buyer_email: donorEmail },
      }),
    });
    const d = await r.json();
    const link = d && d.payment_link;
    if (!r.ok || !link || !link.url) throw new Error('square: ' + ((d.errors && d.errors[0] && (d.errors[0].detail || d.errors[0].code)) || ('http ' + r.status)));
    return { url: link.url, patch: { square_link_id: link.id || '', square_order_id: link.order_id || '', payment_provider: 'square' } };
  }
  // Stripe
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', `${base}/donate-success.html?pledge=${pledgeId}`);
  params.set('cancel_url', `${base}/donate.html`);
  params.set('customer_email', donorEmail);
  params.set('client_reference_id', pledgeId);
  params.set('metadata[kind]', 'donation');
  params.set('metadata[pledge_id]', pledgeId);
  params.set('payment_intent_data[metadata][kind]', 'donation');
  params.set('payment_intent_data[metadata][pledge_id]', pledgeId);
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', 'usd');
  params.set('line_items[0][price_data][unit_amount]', String(amountCents));
  params.set('line_items[0][price_data][product_data][name]', name.slice(0, 240));
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const d = await r.json();
  if (!r.ok || !d.url) throw new Error('stripe: ' + ((d.error && d.error.message) || ('http ' + r.status)));
  return { url: d.url, patch: { stripe_session_id: d.id, stripe_payment_intent: d.payment_intent || '', payment_provider: 'stripe' } };
}

// ── GET: config / info / pay ─────────────────────────────────────────────
async function handleGet(req, res) {
  const q = req.query || {};

  // pay → mint a fresh session and redirect
  if (q.pay) {
    const id = String(q.pay);
    const base = baseUrl(req);
    if (!safeId(id)) return redirect(res, `${base}/donate.html?e=badlink`);
    if (!providerReady()) return redirect(res, `${base}/donate.html?e=unavailable`);
    let pledge;
    try { pledge = await fsGet(`pledges/${id}`); } catch (e) { return redirect(res, `${base}/donate.html?e=payfail`); }
    if (!pledge) return redirect(res, `${base}/donate.html?e=notfound`);
    if (pledge.status === 'paid') return redirect(res, `${base}/donate-success.html?pledge=${id}&already=1`);
    if (pledge.status !== 'invoiced') return redirect(res, `${base}/donate.html?e=notready`);
    const amount = pledge.amount_cents || 0;
    if (amount <= 0) return redirect(res, `${base}/donate.html?e=notready`);
    try {
      const event = await loadEvent();
      const pn = pledge.player_slug === 'general' ? '' : (playerName(event, pledge.player_slug) || '');
      const out = await createDonationCheckout({ pledgeId: id, amountCents: amount, playerName: pn, donorEmail: pledge.donor_email, base });
      try { await fsPatch(`pledges/${id}`, Object.assign({ pay_opened_at: new Date().toISOString() }, out.patch || {})); } catch (e) { /* webhook still matches on metadata */ }
      return redirect(res, out.url);
    } catch (e) {
      return redirect(res, `${base}/donate.html?e=payfail`);
    }
  }

  // info → safe summary for the "complete your donation" page
  if (q.info) {
    res.setHeader('Cache-Control', 'no-store');
    const id = String(q.info);
    if (!safeId(id)) return res.status(400).json({ error: 'bad_id' });
    const pledge = await fsGet(`pledges/${id}`);
    if (!pledge) return res.status(404).json({ error: 'not_found' });
    const event = await loadEvent();
    return res.status(200).json({
      status: pledge.status,
      kind: pledge.kind,
      player_name: pledge.player_slug === 'general' ? 'the team' : (playerName(event, pledge.player_slug) || 'a player'),
      is_general: pledge.player_slug === 'general',
      amount_cents: pledge.amount_cents || 0,
      per_shot_cents: pledge.per_shot_cents || 0,
      cap_cents: pledge.cap_cents || 0,
      flat_cents: pledge.flat_cents || 0,
      makes: pledge.player_slug === 'general' ? null : makesFor(event, pledge.player_slug),
      description: pledgeDescription(pledge),
      donor_first: (String(pledge.donor_name || '').trim().split(/\s+/)[0]) || '',
    });
  }

  // default → public config + live totals (donate.html form + thermometer)
  const event = await loadEvent();
  res.setHeader('Cache-Control', 'public, max-age=30');
  if (!event || !event.open) {
    return res.status(200).json({ open: false, ready: providerReady(), title: (event && event.title) || SHOOTATHON.title });
  }
  let pledges = [];
  try { pledges = await fsQuery('pledges', 'event_id', 'EQUAL', SHOOTATHON.eventId); } catch (e) { pledges = []; }
  const active = pledges.filter((p) => p.status !== 'canceled');
  let perShotTotal = 0, flatTotal = 0, raised = 0;
  for (const p of active) {
    if (p.kind === 'flat') flatTotal += (p.flat_cents || 0);
    else perShotTotal += (p.per_shot_cents || 0);
    if (p.status === 'paid') raised += (p.amount_cents || 0);
  }
  const recent = active.filter((p) => !p.anonymous)
    .sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')))
    .slice(0, 20)
    .map((p) => ({ name: firstNameLastInitial(p.donor_name), backs: p.player_slug === 'general' ? 'the team' : (playerName(event, p.player_slug) || 'a player') }));
  return res.status(200).json({
    open: true,
    ready: providerReady(),
    title: event.title || SHOOTATHON.title,
    blurb: event.blurb || '',
    goal_cents: event.goal_cents || 0,
    players: (event.players || []).map((p) => ({ slug: p.slug, name: p.name })),
    supporter_count: active.length,
    per_shot_total_cents: perShotTotal,
    flat_total_cents: flatTotal,
    raised_cents: raised,
    recent,
  });
}

// ── POST: record a pledge (no card) ──────────────────────────────────────
async function handlePost(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!(fbConfigured() && fbAdminConfigured())) return res.status(503).json({ error: 'not_configured' });
  const event = await loadEvent();
  if (!event || !event.open) return res.status(503).json({ error: 'closed' });

  const norm = normalizePledge(req.body || {});
  if (!norm.ok) return res.status(400).json({ error: norm.error });
  const pledge = norm.pledge;

  if (pledge.player_slug !== 'general' && !((event.players || []).some((p) => p.slug === pledge.player_slug))) {
    return res.status(400).json({ error: 'unknown_player' });
  }

  const ip = String(req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim().slice(0, 60);
  const now = new Date().toISOString();
  const created = await fsCreate('pledges', Object.assign({}, pledge, {
    status: 'pledged',
    amount_cents: 0,
    amount_paid_cents: 0,
    created: now,
    pledge_ip: ip,
  }));
  const id = created && created.name ? String(created.name).split('/').pop() : null;
  if (!id) return res.status(500).json({ error: 'save_failed' });

  // "Thanks for pledging" email — best-effort; a mail hiccup never fails the pledge.
  if (emailConfigured() && pledge.donor_email) {
    try {
      const { subject, html } = buildPledgeEmail(Object.assign({ id }, pledge), playerName(event, pledge.player_slug));
      const ok = await sendMail({ to: pledge.donor_email, subject, html, bcc: ADMIN_EMAIL });
      await fsPatch(`pledges/${id}`, { pledge_email_sent: !!ok, pledge_email_at: now });
    } catch (e) { /* best-effort */ }
  }
  return res.status(200).json({ ok: true, id });
}

export default async function handler(req, res) {
  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(405).json({ error: 'method_not_allowed' });
}
