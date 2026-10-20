// Vercel Serverless Function — /api/shootathon   (ADMIN only)
// The organizer's side of the Shoot-a-Thon. Every action is gated by ADMIN_PASSWORD
// sent in the x-admin-key header (never a URL query param), matched in constant time.
//
// POST { action, ... }:
//   config      → the event config + every pledge (with computed amounts) + totals  [dashboard]
//   set_event   → create/update the event (title, blurb, goal, open flag, player roster)
//   set_makes   → set each player's made-shot count     { makes: { "<slug>": <n>, … } }
//   send_links  → invoice every new pledge for its computed total + email the pay-link
//   resend      → re-email the pay-link for one invoiced pledge        { id }
//   cancel      → cancel a not-yet-paid pledge                         { id }
//   sync        → re-check invoiced pledges against the processor (backup for a missed webhook)
//
// The authoritative charge is ALWAYS recomputed here from the stored pledge + the makes in
// the event doc (computePledgeCents) — never taken from a browser.

import { fbConfigured, fbAdminConfigured, fsGet, fsPatch, fsPatchVerified, fsQuery } from './_firestore.js';
import { SHOOTATHON, LIMITS, slugify, isSlug, intOrNull, computePledgeCents, pledgeDescription } from './_shootathon.js';
import { clip, stripTags } from './_clinic.js';
import { verifyPayment, finalizeDonationPaid } from './_finalize.js';
import { sendMail, buildPayLinkEmail, emailConfigured, ADMIN_EMAIL } from './_email.js';

function ctEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function authed(req) {
  const want = process.env.ADMIN_PASSWORD || '';
  return !!want && ctEq(req.headers['x-admin-key'] || '', want); // header only
}
function safeId(id) { return /^[A-Za-z0-9_-]{1,128}$/.test(String(id || '')); }

const EVENT_PATH = `shootathon/${SHOOTATHON.eventId}`;

function baseUrl(req) {
  if (process.env.SITE_URL) return String(process.env.SITE_URL).replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
async function loadEvent() { return (await fsGet(EVENT_PATH)) || null; }
function makesMap(event) {
  const m = {};
  ((event && event.players) || []).forEach((p) => { m[p.slug] = p.makes || 0; });
  return m;
}
async function loadPledges() {
  try { return await fsQuery('pledges', 'event_id', 'EQUAL', SHOOTATHON.eventId); } catch (e) { return []; }
}
// The link we email — a durable page on our site (NOT a processor session, which would expire).
function payLink(base, id) { return `${base}/donate-pay.html?p=${id}`; }

// ── Actions ───────────────────────────────────────────────────────────────
async function actionConfig() {
  const event = await loadEvent();
  const mm = makesMap(event);
  const pledges = await loadPledges();
  let pledgedCount = 0, paidCount = 0, raisedCents = 0, projectedCents = 0, perShotRateCents = 0, flatCents = 0;
  const rows = pledges.map((p) => {
    const makes = p.player_slug === 'general' ? null : (mm[p.player_slug] || 0);
    const computed = p.status === 'paid'
      ? (p.amount_paid_cents || p.amount_cents || 0)
      : computePledgeCents(p, makes);
    if (p.status !== 'canceled') {
      pledgedCount++;
      if (p.kind === 'flat') flatCents += (p.flat_cents || 0); else perShotRateCents += (p.per_shot_cents || 0);
      projectedCents += computed;
    }
    if (p.status === 'paid') { paidCount++; raisedCents += (p.amount_paid_cents || p.amount_cents || 0); }
    return {
      id: p.id,
      status: p.status,
      kind: p.kind,
      player_slug: p.player_slug,
      donor_name: p.donor_name,
      donor_email: p.donor_email,
      anonymous: !!p.anonymous,
      message: p.message || '',
      per_shot_cents: p.per_shot_cents || 0,
      cap_cents: p.cap_cents || 0,
      flat_cents: p.flat_cents || 0,
      amount_cents: p.amount_cents || 0,
      computed_cents: computed,
      makes,
      description: pledgeDescription(p),
      created: p.created || '',
      paid_at: p.paid_at || '',
      card_last4: p.card_last4 || '',
    };
  });
  return {
    ok: true,
    event: event ? {
      event_id: SHOOTATHON.eventId, title: event.title || SHOOTATHON.title, blurb: event.blurb || '',
      goal_cents: event.goal_cents || 0, open: !!event.open,
      players: (event.players || []).map((p) => ({ slug: p.slug, name: p.name, makes: p.makes || 0 })),
    } : { event_id: SHOOTATHON.eventId, title: SHOOTATHON.title, blurb: '', goal_cents: 0, open: false, players: [] },
    totals: {
      pledges: pledgedCount, paid: paidCount,
      raised_cents: raisedCents, projected_cents: projectedCents,
      per_shot_rate_cents: perShotRateCents, flat_cents: flatCents,
    },
    pledges: rows.sort((a, b) => String(b.created).localeCompare(String(a.created))),
  };
}

async function actionSetEvent(b) {
  const prev = await loadEvent();
  const prevMakes = makesMap(prev);
  const patch = {};
  if (b.title != null) patch.title = stripTags(clip(b.title, 120)).trim() || SHOOTATHON.title;
  if (b.blurb != null) patch.blurb = stripTags(clip(b.blurb, 500)).trim();
  if (b.goal_cents != null) { const g = intOrNull(b.goal_cents); patch.goal_cents = g == null ? 0 : Math.min(g, 100000000); }
  if (b.open != null) patch.open = !!b.open;
  if (Array.isArray(b.players)) {
    if (b.players.length > 100) return { status: 400, body: { error: 'too_many_players' } };
    const seen = new Set();
    const players = [];
    for (const raw of b.players) {
      const name = stripTags(clip(raw && raw.name, 80)).trim();
      if (!name) continue;
      let slug = (raw && raw.slug && isSlug(String(raw.slug))) ? String(raw.slug) : slugify(name);
      if (!slug) slug = 'player';
      let unique = slug, n = 2;
      while (seen.has(unique)) unique = `${slug}-${n++}`.slice(0, 40);
      seen.add(unique);
      // Preserve a player's existing makes across edits (match by the previous slug or the new one).
      const makes = (raw && intOrNull(raw.makes) != null) ? Math.min(intOrNull(raw.makes), LIMITS.maxMakes)
        : (prevMakes[unique] != null ? prevMakes[unique] : (prevMakes[slug] || 0));
      players.push({ slug: unique, name, makes });
    }
    patch.players = players;
  }
  patch.updated_at = new Date().toISOString();
  const w = await fsPatchVerified(EVENT_PATH, patch); // PATCH upserts: creates the doc if absent
  if (!w.ok) return { status: 502, body: { error: 'save_failed' } };
  return { status: 200, body: { ok: true } };
}

async function actionSetMakes(b) {
  const event = await loadEvent();
  if (!event) return { status: 400, body: { error: 'no_event' } };
  const makes = (b && b.makes && typeof b.makes === 'object') ? b.makes : {};
  const players = (event.players || []).map((p) => {
    if (Object.prototype.hasOwnProperty.call(makes, p.slug)) {
      const n = intOrNull(makes[p.slug]);
      return Object.assign({}, p, { makes: n == null ? (p.makes || 0) : Math.min(n, LIMITS.maxMakes) });
    }
    return p;
  });
  const w = await fsPatchVerified(EVENT_PATH, { players, updated_at: new Date().toISOString() });
  if (!w.ok) return { status: 502, body: { error: 'save_failed' } };
  return { status: 200, body: { ok: true, players: players.map((p) => ({ slug: p.slug, name: p.name, makes: p.makes })) } };
}

async function actionSendLinks(req, b) {
  if (!emailConfigured()) return { status: 503, body: { error: 'email_not_configured' } };
  const event = await loadEvent();
  if (!event) return { status: 400, body: { error: 'no_event' } };
  const mm = makesMap(event);
  const base = baseUrl(req);
  const onlyPledged = (b && b.id) ? [await fsGet(`pledges/${b.id}`)].filter(Boolean) : await loadPledges();
  let invoiced = 0, emailed = 0, zero = 0, skipped = 0, failed = 0, remaining = 0;
  const CAP = 150; // keep one invocation comfortably within the function time budget
  for (const p of onlyPledged) {
    if (!p || !p.id) continue;
    if (p.status !== 'pledged') { skipped++; continue; }
    if (invoiced + zero >= CAP) { remaining++; continue; }
    const makes = p.player_slug === 'general' ? null : (mm[p.player_slug] || 0);
    const amount = computePledgeCents(p, makes);
    if (amount <= 0) {
      // Per-shot pledge whose player made 0 (or a sub-minimum total): nothing to collect.
      await fsPatch(`pledges/${p.id}`, { status: 'no_charge', amount_cents: 0, invoiced_at: new Date().toISOString() });
      zero++;
      continue;
    }
    const w = await fsPatchVerified(`pledges/${p.id}`, { status: 'invoiced', amount_cents: amount, invoiced_at: new Date().toISOString() });
    if (!w.ok) { failed++; continue; }
    invoiced++;
    try {
      const merged = Object.assign({}, p, { status: 'invoiced', amount_cents: amount });
      const pName = p.player_slug === 'general' ? '' : ((event.players || []).find((x) => x.slug === p.player_slug) || {}).name || '';
      const { subject, html } = buildPayLinkEmail(merged, pName, payLink(base, p.id), makes);
      const ok = await sendMail({ to: p.donor_email, subject, html, bcc: ADMIN_EMAIL });
      await fsPatch(`pledges/${p.id}`, { paylink_email_sent: !!ok, paylink_email_at: new Date().toISOString() });
      if (ok) emailed++;
    } catch (e) { /* invoiced stands; admin can resend */ }
  }
  return { status: 200, body: { ok: true, invoiced, emailed, zero, skipped, failed, remaining } };
}

async function actionResend(req, b) {
  if (!safeId(b && b.id)) return { status: 400, body: { error: 'bad_id' } };
  if (!emailConfigured()) return { status: 503, body: { error: 'email_not_configured' } };
  const p = await fsGet(`pledges/${b.id}`);
  if (!p) return { status: 404, body: { error: 'not_found' } };
  if (p.status !== 'invoiced') return { status: 400, body: { error: 'not_invoiced' } };
  const event = await loadEvent();
  const makes = p.player_slug === 'general' ? null : (makesMap(event)[p.player_slug] || 0);
  const pName = p.player_slug === 'general' ? '' : ((event && event.players || []).find((x) => x.slug === p.player_slug) || {}).name || '';
  const { subject, html } = buildPayLinkEmail(p, pName, payLink(baseUrl(req), p.id), makes);
  const ok = await sendMail({ to: p.donor_email, subject, html, bcc: ADMIN_EMAIL });
  await fsPatch(`pledges/${b.id}`, { paylink_email_sent: !!ok, paylink_email_at: new Date().toISOString() });
  return { status: ok ? 200 : 502, body: ok ? { ok: true } : { error: 'send_failed' } };
}

async function actionCancel(b) {
  if (!safeId(b && b.id)) return { status: 400, body: { error: 'bad_id' } };
  const p = await fsGet(`pledges/${b.id}`);
  if (!p) return { status: 404, body: { error: 'not_found' } };
  if (p.status === 'paid') return { status: 400, body: { error: 'already_paid' } }; // use a refund, not cancel
  if (p.status === 'canceled') return { status: 200, body: { ok: true, already: true } };
  const w = await fsPatchVerified(`pledges/${b.id}`, { status: 'canceled', canceled_at: new Date().toISOString() });
  if (!w.ok) return { status: 502, body: { error: 'save_failed' } };
  return { status: 200, body: { ok: true } };
}

async function actionSync() {
  const pledges = await loadPledges();
  let checked = 0, paid = 0;
  for (const p of pledges) {
    if (p.status !== 'invoiced') continue;
    checked++;
    try {
      const v = await verifyPayment(p);
      if (v.paid) { await finalizeDonationPaid(p.id, p, v.patch); paid++; }
    } catch (e) { /* best-effort backup */ }
  }
  return { status: 200, body: { ok: true, checked, paid } };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: 'admin_not_configured' });
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!fbConfigured() || !fbAdminConfigured()) return res.status(503).json({ error: 'db_not_configured' });

  const b = req.body || {};
  const action = String(b.action || '');
  try {
    if (action === 'config') return res.status(200).json(await actionConfig());
    if (action === 'set_event') { const r = await actionSetEvent(b); return res.status(r.status).json(r.body); }
    if (action === 'set_makes') { const r = await actionSetMakes(b); return res.status(r.status).json(r.body); }
    if (action === 'send_links') { const r = await actionSendLinks(req, b); return res.status(r.status).json(r.body); }
    if (action === 'resend') { const r = await actionResend(req, b); return res.status(r.status).json(r.body); }
    if (action === 'cancel') { const r = await actionCancel(b); return res.status(r.status).json(r.body); }
    if (action === 'sync') { const r = await actionSync(); return res.status(r.status).json(r.body); }
    return res.status(400).json({ error: 'unknown_action' });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
}
