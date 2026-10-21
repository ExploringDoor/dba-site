// Vercel Serverless Function — /api/pledge   (public, same-origin)
// The supporter-facing side of the Shoot-a-Thon. No admin auth.
//
//   GET  /api/pledge              → full fundraiser snapshot (org/team/player goals + raised + recent)
//   GET  /api/pledge?info=<id>    → a SAFE summary of one PLEDGE for the after-event pay page
//   GET  /api/pledge?pay=<id>     → mint a FRESH hosted checkout for an invoiced pledge and 302 to it
//   POST /api/pledge              → a ONE-TIME donation (kind:flat) is paid now: returns {url} to a
//                                    hosted checkout. A per-made-throw PLEDGE (kind:per_shot) is just
//                                    recorded (no charge) and billed after the event via a pay-link.
//
// Donations roll up: a gift to a player counts toward that player, their team, and the org.
// The per-shot charge is always recomputed server-side from the stored pledge × admin-entered makes.

import { fbConfigured, fbAdminConfigured, fsGet, fsCreate, fsQuery, fsPatch, fsPatchVerified } from './_firestore.js';
import { SHOOTATHON, normalizePledge, pledgeDescription, computePledgeCents, coverFeeCents } from './_shootathon.js';
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
function findTeam(event, slug) { return ((event && event.teams) || []).find((t) => t.slug === slug) || null; }
function findPlayer(event, slug) { return ((event && event.players) || []).find((p) => p.slug === slug) || null; }
function makesFor(event, slug) { const p = findPlayer(event, slug); return p ? (p.makes || 0) : 0; }
function targetName(event, type, slug) {
  if (type === 'team') { const t = findTeam(event, slug); return t ? t.name : 'a team'; }
  if (type === 'player') { const p = findPlayer(event, slug); return p ? p.name : 'a player'; }
  return 'the whole program';
}
function firstNameLastInitial(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'A supporter';
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}
// Normalize legacy records (player_slug) onto the target_type/target_slug model used everywhere now.
function targetOf(p) {
  if (p.target_type) return { type: p.target_type, slug: p.target_slug || '' };
  if (p.player_slug && p.player_slug !== 'general') return { type: 'player', slug: p.player_slug };
  return { type: 'org', slug: '' };
}

// ── Hosted checkout for a donation (mints at call-time; supports either provider) ──
async function createDonationCheckout({ pledgeId, amountCents, label, donorEmail, base }) {
  const name = ('Shoot-a-Thon donation' + (label ? ' — ' + label : '')).slice(0, 240);
  if (PROVIDER === 'square') {
    const ENV = (process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();
    const API = ENV === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
    const r = await fetch(`${API}/v2/online-checkout/payment-links`, {
      method: 'POST',
      headers: { 'Square-Version': '2024-10-17', Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotency_key: ('don_' + pledgeId + '_' + Date.now()).slice(0, 45),
        quick_pay: { name, price_money: { amount: amountCents, currency: 'USD' }, location_id: process.env.SQUARE_LOCATION_ID },
        checkout_options: { redirect_url: `${base}/donate-success.html?pledge=${pledgeId}`, ask_for_shipping_address: false },
        pre_populated_data: { buyer_email: donorEmail },
      }),
    });
    const d = await r.json();
    const link = d && d.payment_link;
    if (!r.ok || !link || !link.url) throw new Error('square: ' + ((d.errors && d.errors[0] && (d.errors[0].detail || d.errors[0].code)) || ('http ' + r.status)));
    return { url: link.url, patch: { square_link_id: link.id || '', square_order_id: link.order_id || '', payment_provider: 'square' } };
  }
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
  params.set('line_items[0][price_data][product_data][name]', name);
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const d = await r.json();
  if (!r.ok || !d.url) throw new Error('stripe: ' + ((d.error && d.error.message) || ('http ' + r.status)));
  return { url: d.url, patch: { stripe_session_id: d.id, stripe_payment_intent: d.payment_intent || '', payment_provider: 'stripe' } };
}

// ── Build the public snapshot with rolled-up raised totals ─────────────────
function buildSnapshot(event, pledges) {
  const teams = (event.teams || []).map((t) => ({ slug: t.slug, name: t.name, goal_cents: t.goal_cents || 0, raised_cents: 0 }));
  const teamBySlug = {}; teams.forEach((t) => { teamBySlug[t.slug] = t; });
  const players = (event.players || []).map((p) => ({ slug: p.slug, name: p.name, team: p.team || '', blurb: p.blurb || '', goal_cents: p.goal_cents || 0, raised_cents: 0, makes: p.makes || 0 }));
  const playerBySlug = {}; players.forEach((p) => { playerBySlug[p.slug] = p; });
  let orgRaised = 0, supporters = 0;
  const recent = [];
  for (const p of pledges) {
    if (p.status === 'canceled') continue;
    supporters++;
    const tg = targetOf(p);
    const paid = p.status === 'paid';
    // The thermometer reflects the DONATION value (net of any fee the donor chose to cover —
    // that extra just offsets Stripe, it isn't a bigger gift to the cause).
    const amt = paid ? Math.max(0, (p.amount_paid_cents || p.amount_cents || 0) - (p.fee_cents || 0)) : 0;
    if (amt > 0) {
      orgRaised += amt;
      if (tg.type === 'player') {
        const pl = playerBySlug[tg.slug]; if (pl) { pl.raised_cents += amt; const tm = teamBySlug[pl.team]; if (tm) tm.raised_cents += amt; }
      } else if (tg.type === 'team') {
        const tm = teamBySlug[tg.slug]; if (tm) tm.raised_cents += amt;
      }
    }
    recent.push({
      name: p.anonymous ? 'Anonymous' : firstNameLastInitial(p.donor_name),
      message: p.anonymous ? '' : (p.message || ''),
      backs: targetName(event, tg.type, tg.slug),
      target_type: tg.type, target_slug: tg.slug,
      kind: p.kind, paid,
      created: p.created || '',
    });
  }
  recent.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return {
    org: { goal_cents: event.org_goal_cents || 0, raised_cents: orgRaised },
    teams, players,
    supporter_count: supporters,
    recent: recent.slice(0, 40),
  };
}

// ── GET ────────────────────────────────────────────────────────────────────
async function handleGet(req, res) {
  const q = req.query || {};

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
      const tg = targetOf(pledge);
      const out = await createDonationCheckout({ pledgeId: id, amountCents: amount, label: targetName(event, tg.type, tg.slug), donorEmail: pledge.donor_email, base });
      try { await fsPatch(`pledges/${id}`, Object.assign({ pay_opened_at: new Date().toISOString() }, out.patch || {})); } catch (e) { /* webhook still matches on metadata */ }
      return redirect(res, out.url);
    } catch (e) {
      return redirect(res, `${base}/donate.html?e=payfail`);
    }
  }

  if (q.info) {
    res.setHeader('Cache-Control', 'no-store');
    const id = String(q.info);
    if (!safeId(id)) return res.status(400).json({ error: 'bad_id' });
    const pledge = await fsGet(`pledges/${id}`);
    if (!pledge) return res.status(404).json({ error: 'not_found' });
    const event = await loadEvent();
    const tg = targetOf(pledge);
    return res.status(200).json({
      status: pledge.status, kind: pledge.kind,
      target_type: tg.type, target_name: targetName(event, tg.type, tg.slug),
      amount_cents: pledge.amount_cents || 0, per_shot_cents: pledge.per_shot_cents || 0,
      makes: tg.type === 'player' ? makesFor(event, tg.slug) : null,
      description: pledgeDescription(pledge),
      donor_first: (String(pledge.donor_name || '').trim().split(/\s+/)[0]) || '',
    });
  }

  // default → full fundraiser snapshot
  const event = await loadEvent();
  res.setHeader('Cache-Control', 'public, max-age=15');
  if (!event || !event.open) {
    return res.status(200).json({ open: false, ready: providerReady(), title: (event && event.title) || SHOOTATHON.title });
  }
  let pledges = [];
  try { pledges = await fsQuery('pledges', 'event_id', 'EQUAL', SHOOTATHON.eventId); } catch (e) { pledges = []; }
  const snap = buildSnapshot(event, pledges);
  return res.status(200).json(Object.assign({ open: true, ready: providerReady(), title: event.title || SHOOTATHON.title, blurb: event.blurb || '', event_date: event.event_date || '', about: event.about || '', match_text: event.match_text || '' }, snap));
}

// ── POST ─────────────────────────────────────────────────────────────────
async function handlePost(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!(fbConfigured() && fbAdminConfigured())) return res.status(503).json({ error: 'not_configured' });
  const event = await loadEvent();
  if (!event || !event.open) return res.status(503).json({ error: 'closed' });

  const norm = normalizePledge(req.body || {});
  if (!norm.ok) return res.status(400).json({ error: norm.error });
  const pledge = norm.pledge;

  // Validate the target exists in the live event.
  if (pledge.target_type === 'player' && !findPlayer(event, pledge.target_slug)) return res.status(400).json({ error: 'unknown_player' });
  if (pledge.target_type === 'team' && !findTeam(event, pledge.target_slug)) return res.status(400).json({ error: 'unknown_team' });

  const ip = String(req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim().slice(0, 60);
  const now = new Date().toISOString();

  // ── ONE-TIME DONATION → pay now ──
  if (pledge.kind === 'flat') {
    if (!providerReady()) return res.status(503).json({ error: 'not_configured' });
    const base = pledge.flat_cents;
    const fee = pledge.cover_fee ? coverFeeCents(base) : 0;   // authoritative — never trust the browser
    const amount = base + fee;
    const created = await fsCreate('pledges', Object.assign({}, pledge, {
      status: 'pending', amount_cents: amount, fee_cents: fee, amount_paid_cents: 0, created: now, pledge_ip: ip,
    }));
    const id = created && created.name ? String(created.name).split('/').pop() : null;
    if (!id) return res.status(500).json({ error: 'save_failed' });
    try {
      const out = await createDonationCheckout({ pledgeId: id, amountCents: amount, label: targetName(event, pledge.target_type, pledge.target_slug), donorEmail: pledge.donor_email, base: baseUrl(req) });
      const w = await fsPatchVerified(`pledges/${id}`, Object.assign({ checkout_url: out.url }, out.patch || {}));
      if (!w.ok) { await fsPatch(`pledges/${id}`, { status: 'error', error_detail: 'link_persist_failed' }); return res.status(503).json({ error: 'checkout_unavailable' }); }
      return res.status(200).json({ pay: true, url: out.url, id });
    } catch (e) {
      await fsPatch(`pledges/${id}`, { status: 'error', error_detail: String(e.message || e).slice(0, 300) });
      return res.status(502).json({ error: 'checkout_failed' });
    }
  }

  // ── PER-MADE-THROW PLEDGE → record now, bill after the event ──
  const created = await fsCreate('pledges', Object.assign({}, pledge, {
    status: 'pledged', amount_cents: 0, amount_paid_cents: 0, created: now, pledge_ip: ip,
  }));
  const id = created && created.name ? String(created.name).split('/').pop() : null;
  if (!id) return res.status(500).json({ error: 'save_failed' });
  if (emailConfigured() && pledge.donor_email) {
    try {
      const { subject, html } = buildPledgeEmail(Object.assign({ id }, pledge), targetName(event, pledge.target_type, pledge.target_slug));
      const ok = await sendMail({ to: pledge.donor_email, subject, html, bcc: ADMIN_EMAIL });
      await fsPatch(`pledges/${id}`, { pledge_email_sent: !!ok, pledge_email_at: now });
    } catch (e) { /* best-effort */ }
  }
  return res.status(200).json({ pledged: true, id });
}

export default async function handler(req, res) {
  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(405).json({ error: 'method_not_allowed' });
}
