// Vercel Serverless Function — /api/shootathon   (ADMIN only)
// The organizer's side of the Shoot-a-Thon. Gated by ADMIN_PASSWORD in the x-admin-key header.
//
// POST { action, ... }:
//   config      → event config (org goal + teams + players) + every pledge + totals   [dashboard]
//   set_event   → create/update the event (title, blurb, org goal, open, teams[], players[])
//   set_makes   → set each player's made-free-throw count   { makes: { "<slug>": <n>, … } }
//   send_links  → invoice every new per-throw pledge for its computed total + email the pay-link
//   resend      → re-email the pay-link for one invoiced pledge        { id }
//   cancel      → cancel a not-yet-paid pledge                         { id }
//   refund      → refund a paid donation in full + email the donor    { id }
//   edit        → fix a donation's donor name/email/message/anonymous, who it supports, and
//                 (cash/check gifts only) the amount and method       { id, ... }
//   remove      → hide a donation that holds no card money (test entries, mistakes)   { id }
//   restore     → undo a remove                                        { id }
//   add_offline → record a cash/check gift so it counts toward the goals  { donor_name, amount_cents, ... }
//   mark_paid   → a per-throw pledge paid by cash/check instead of the pay-link   { id, method }
//   receipt     → re-email the receipt for a paid donation              { id }
//   sync        → re-check invoiced pledges against the processor (backup for a missed webhook)
//
// One-time donations are paid at donation time (not here). The per-throw charge is ALWAYS
// recomputed here from the stored pledge × the makes in the event doc (computePledgeCents).

import { fbConfigured, fbAdminConfigured, fsGet, fsGetMeta, fsCreate, fsPatch, fsPatchVerified, fsQuery } from './_firestore.js';
import { SHOOTATHON, LIMITS, slugify, isSlug, intOrNull, computePledgeCents, pledgeDescription, normalizeTeam, coverFeeCents } from './_shootathon.js';
import { clip, stripTags, validEmail } from './_clinic.js';
import { verifyPayment, finalizeDonationPaid } from './_finalize.js';
import { sendMail, buildPayLinkEmail, buildDonationRefundEmail, buildDonationReceiptEmail, emailConfigured, ADMIN_EMAIL } from './_email.js';
import { SITE_TAG } from './_site.js';
import { refundStripe, refundSquare } from './_refund.js';

function ctEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function authed(req) { const want = process.env.ADMIN_PASSWORD || ''; return !!want && ctEq(req.headers['x-admin-key'] || '', want); }
function safeId(id) { return /^[A-Za-z0-9_-]{1,128}$/.test(String(id || '')); }

const EVENT_PATH = `shootathon/${SHOOTATHON.eventId}`;

function baseUrl(req) {
  if (process.env.SITE_URL) return String(process.env.SITE_URL).replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
async function loadEvent() { return (await fsGet(EVENT_PATH)) || null; }
function makesMap(event) { const m = {}; ((event && event.players) || []).forEach((p) => { m[p.slug] = p.makes || 0; }); return m; }
function findPlayer(event, slug) { return ((event && event.players) || []).find((p) => p.slug === slug) || null; }
function findTeam(event, slug) { return ((event && event.teams) || []).find((t) => t.slug === slug) || null; }
function targetOf(p) {
  if (p.target_type) return { type: p.target_type, slug: p.target_slug || '' };
  if (p.player_slug && p.player_slug !== 'general') return { type: 'player', slug: p.player_slug };
  return { type: 'org', slug: '' };
}
function targetName(event, tg) {
  if (tg.type === 'team') { const t = findTeam(event, tg.slug); return t ? t.name : 'a team'; }
  if (tg.type === 'player') { const p = findPlayer(event, tg.slug); return p ? p.name : 'a player'; }
  return 'the whole program';
}
async function loadPledges() { try { return await fsQuery('pledges', 'event_id', 'EQUAL', SHOOTATHON.eventId); } catch (e) { return []; } }
function payLink(base, id) { return `${base}/donate-pay.html?p=${id}`; }

// ── Actions ───────────────────────────────────────────────────────────────
async function actionConfig() {
  const event = await loadEvent();
  const mm = makesMap(event);
  const pledges = await loadPledges();
  let pledgeCount = 0, paidCount = 0, raisedCents = 0, projectedCents = 0, refundedCents = 0;
  const rows = pledges.map((p) => {
    const tg = targetOf(p);
    const makes = tg.type === 'player' ? (mm[tg.slug] || 0) : null;
    const settled = p.status === 'paid' || p.status === 'refunded';
    const computed = settled ? (p.amount_paid_cents || p.amount_cents || 0) : computePledgeCents(p, makes);
    if (p.status === 'refunded') refundedCents += (p.amount_refunded_cents || 0);
    else if (p.status !== 'canceled' && p.status !== 'removed') { pledgeCount++; projectedCents += computed; }
    if (p.status === 'paid') { paidCount++; raisedCents += (p.amount_paid_cents || p.amount_cents || 0); }
    return {
      id: p.id, status: p.status, kind: p.kind,
      target_type: tg.type, target_slug: tg.slug, target_name: targetName(event, tg),
      donor_name: p.donor_name, donor_email: p.donor_email, anonymous: !!p.anonymous, message: p.message || '',
      per_shot_cents: p.per_shot_cents || 0, cap_cents: p.cap_cents || 0, flat_cents: p.flat_cents || 0,
      amount_cents: p.amount_cents || 0, computed_cents: computed, makes,
      description: pledgeDescription(p), created: p.created || '', paid_at: p.paid_at || '', card_last4: p.card_last4 || '',
      refunded_at: p.refunded_at || '', amount_refunded_cents: p.amount_refunded_cents || 0,
      fee_cents: p.fee_cents || 0, cover_fee: !!p.cover_fee, paid_via: p.paid_via || '', offline: !!p.offline,
      check_no: p.check_no || '', note: p.note || '', invoiced_at: p.invoiced_at || '', removed_at: p.removed_at || '',
      refundable: p.status === 'paid' && !!(p.stripe_payment_intent || p.square_payment_id),
    };
  });
  const ev = event || {};
  return {
    ok: true,
    event: {
      event_id: SHOOTATHON.eventId, title: ev.title || SHOOTATHON.title, blurb: ev.blurb || '',
      open: !!ev.open, org_goal_cents: ev.org_goal_cents || 0,
      event_date: ev.event_date || '', about: ev.about || '', match_text: ev.match_text || '',
      teams: (ev.teams || []).map((t) => ({ slug: t.slug, name: t.name, goal_cents: t.goal_cents || 0 })),
      players: (ev.players || []).map((p) => ({ slug: p.slug, name: p.name, team: p.team || '', goal_cents: p.goal_cents || 0, makes: p.makes || 0, blurb: p.blurb || '' })),
    },
    totals: { pledges: pledgeCount, paid: paidCount, raised_cents: raisedCents, projected_cents: projectedCents, refunded_cents: refundedCents },
    pledges: rows.sort((a, b) => String(b.created).localeCompare(String(a.created))),
  };
}

async function actionSetEvent(b) {
  const prev = await loadEvent();
  const patch = {};
  if (b.title != null) patch.title = stripTags(clip(b.title, 120)).trim() || SHOOTATHON.title;
  if (b.blurb != null) patch.blurb = stripTags(clip(b.blurb, 500)).trim();
  if (b.about != null) patch.about = stripTags(clip(b.about, 2000)).trim();
  if (b.match_text != null) patch.match_text = stripTags(clip(b.match_text, 200)).trim();
  if (b.event_date != null) { const d = String(b.event_date || '').trim(); patch.event_date = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : ''; }
  if (b.open != null) patch.open = !!b.open;
  if (b.org_goal_cents != null) { const g = intOrNull(b.org_goal_cents); patch.org_goal_cents = g == null ? SHOOTATHON.defaultOrgGoalCents : Math.min(g, LIMITS.maxGoalCents); }

  // Teams (process first so player team-refs can be validated against them).
  let teams = (prev && Array.isArray(prev.teams)) ? prev.teams.slice() : [];
  if (Array.isArray(b.teams)) {
    if (b.teams.length > 30) return { status: 400, body: { error: 'too_many_teams' } };
    const used = new Set(); teams = [];
    for (const raw of b.teams) { const t = normalizeTeam(raw, used); if (t) teams.push(t); }
    patch.teams = teams;
  }
  const isTeam = (slug) => teams.some((t) => t.slug === slug);

  if (Array.isArray(b.players)) {
    if (b.players.length > 300) return { status: 400, body: { error: 'too_many_players' } };
    const prevMakes = {}; ((prev && prev.players) || []).forEach((p) => { prevMakes[p.slug] = p.makes || 0; });
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
      let team = String((raw && raw.team) || '').trim().toLowerCase();
      if (team && !isTeam(team)) team = ''; // drop a ref to a team that doesn't exist
      const g = intOrNull(raw && raw.goal_cents);
      const goal_cents = g == null ? SHOOTATHON.defaultPlayerGoalCents : Math.min(g, LIMITS.maxGoalCents);
      const makes = (raw && intOrNull(raw.makes) != null) ? Math.min(intOrNull(raw.makes), LIMITS.maxMakes)
        : (prevMakes[unique] != null ? prevMakes[unique] : (prevMakes[slug] || 0));
      players.push({ slug: unique, name, team, goal_cents, makes, blurb: stripTags(clip(raw && raw.blurb, 300)).trim() });
    }
    patch.players = players;
  }
  patch.updated_at = new Date().toISOString();
  const w = await fsPatchVerified(EVENT_PATH, patch);
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
  const list = (b && b.id) ? [await fsGet(`pledges/${b.id}`)].filter(Boolean) : await loadPledges();
  let invoiced = 0, emailed = 0, zero = 0, skipped = 0, failed = 0, remaining = 0;
  const CAP = 150;
  for (const p of list) {
    if (!p || !p.id) continue;
    if (p.status !== 'pledged') { skipped++; continue; }  // only per-throw pledges reach 'pledged'
    if (invoiced + zero >= CAP) { remaining++; continue; }
    const tg = targetOf(p);
    const makes = tg.type === 'player' ? (mm[tg.slug] || 0) : null;
    const computed = computePledgeCents(p, makes);
    if (computed <= 0) {
      await fsPatch(`pledges/${p.id}`, { status: 'no_charge', amount_cents: 0, invoiced_at: new Date().toISOString() });
      zero++;
      continue;
    }
    const fee = p.cover_fee ? coverFeeCents(computed) : 0;   // donor opted to cover the processing fee
    const amount = computed + fee;
    const w = await fsPatchVerified(`pledges/${p.id}`, { status: 'invoiced', amount_cents: amount, fee_cents: fee, invoiced_at: new Date().toISOString() });
    if (!w.ok) { failed++; continue; }
    invoiced++;
    try {
      const { subject, html } = buildPayLinkEmail(Object.assign({}, p, { status: 'invoiced', amount_cents: amount }), targetName(event, tg), payLink(base, p.id), makes);
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
  const tg = targetOf(p);
  const makes = tg.type === 'player' ? (makesMap(event)[tg.slug] || 0) : 0;
  const { subject, html } = buildPayLinkEmail(p, targetName(event, tg), payLink(baseUrl(req), p.id), makes);
  const ok = await sendMail({ to: p.donor_email, subject, html, bcc: ADMIN_EMAIL });
  await fsPatch(`pledges/${b.id}`, { paylink_email_sent: !!ok, paylink_email_at: new Date().toISOString() });
  return { status: ok ? 200 : 502, body: ok ? { ok: true } : { error: 'send_failed' } };
}

async function actionCancel(b) {
  if (!safeId(b && b.id)) return { status: 400, body: { error: 'bad_id' } };
  const p = await fsGet(`pledges/${b.id}`);
  if (!p) return { status: 404, body: { error: 'not_found' } };
  if (p.status === 'paid') return { status: 400, body: { error: 'already_paid' } };
  if (p.status === 'canceled') return { status: 200, body: { ok: true, already: true } };
  const w = await fsPatchVerified(`pledges/${b.id}`, { status: 'canceled', canceled_at: new Date().toISOString() });
  if (!w.ok) return { status: 502, body: { error: 'save_failed' } };
  return { status: 200, body: { ok: true } };
}

// Full refund of a paid donation, through the provider that took it. The pledge becomes
// 'refunded', which drops it from every total and the public supporter list.
async function actionRefund(b) {
  if (!safeId(b && b.id)) return { status: 400, body: { error: 'bad_id' } };
  const meta = await fsGetMeta(`pledges/${b.id}`);
  if (!meta) return { status: 404, body: { error: 'not_found' } };
  const p = meta.doc;
  if (p.status === 'refunded') return { status: 400, body: { error: 'already_refunded' } };
  if (p.status !== 'paid') return { status: 400, body: { error: 'not_paid' } };
  if (!(p.stripe_payment_intent || p.square_payment_id)) return { status: 400, body: { error: 'not_refundable' } };
  const cents = p.amount_paid_cents || p.amount_cents || 0;
  if (cents <= 0) return { status: 400, body: { error: 'nothing_to_refund' } };

  let out = null;
  try {
    out = p.payment_provider === 'square' ? await refundSquare(p, cents, `rf_${p.id}_full`) : await refundStripe(p, cents, `rf_${p.id}_full`);
  } catch (e) {
    return { status: 502, body: { error: 'refund_failed', detail: String(e.message || e).slice(0, 200) } };
  }
  const patch = { status: 'refunded', amount_refunded_cents: cents, refunded_at: new Date().toISOString(), last_refund_id: out.id || '' };
  const w = await fsPatchVerified(`pledges/${b.id}`, patch, 4, { ifUpdateTime: meta.updateTime });
  if (!w.ok) {
    // Money went back at the processor but the record didn't update. Say so; never invite a second refund.
    return { status: 500, body: { error: 'refund_sent_but_record_not_updated', refund_id: out.id || '', message: `The refund of $${(cents / 100).toFixed(2)} went through (refund ${out.id || ''}), but this donation's record could not be updated. Reload before doing anything else. Do NOT refund again.` } };
  }
  try {
    if (p.donor_email && emailConfigured()) {
      const { subject, html } = buildDonationRefundEmail(Object.assign({}, p, patch), cents);
      await sendMail({ to: p.donor_email, subject, html, bcc: ADMIN_EMAIL });
    }
  } catch (e) { /* the refund already succeeded */ }
  return { status: 200, body: { ok: true, refunded_cents: cents } };
}

const OFFLINE_METHODS = { cash: 'Cash', check: 'Check', venmo: 'Venmo', zelle: 'Zelle', other: 'Other' };
function cleanTarget(event, b, kind) {
  const type = ['org', 'team', 'player'].includes(b.target_type) ? b.target_type : 'org';
  const slug = type === 'org' ? '' : String(b.target_slug || '').trim().toLowerCase();
  if (type === 'player' && !findPlayer(event, slug)) return { error: 'unknown_player' };
  if (type === 'team' && !findTeam(event, slug)) return { error: 'unknown_team' };
  if (kind === 'per_shot' && type !== 'player') return { error: 'per_shot_needs_player' };
  return { target_type: type, target_slug: slug };
}
function cleanDonor(b, needEmail) {
  const out = {};
  if (b.donor_name != null) { out.donor_name = stripTags(clip(b.donor_name, 120)).trim(); if (!out.donor_name) return { error: 'missing_name' }; }
  if (b.donor_email != null) {
    out.donor_email = clip(b.donor_email, 200).trim().toLowerCase();
    if ((out.donor_email || needEmail) && !validEmail(out.donor_email)) return { error: 'bad_email' };
  }
  if (b.message != null) out.message = stripTags(clip(b.message, 280)).trim();
  if (b.anonymous != null) out.anonymous = !!b.anonymous;
  if (b.note != null) out.note = stripTags(clip(b.note, 500)).trim();
  return out;
}

async function actionEdit(b) {
  if (!safeId(b && b.id)) return { status: 400, body: { error: 'bad_id' } };
  const p = await fsGet(`pledges/${b.id}`);
  if (!p) return { status: 404, body: { error: 'not_found' } };
  const patch = cleanDonor(b, false);
  if (patch.error) return { status: 400, body: { error: patch.error } };
  if (b.target_type != null) {
    const tg = cleanTarget(await loadEvent(), b, p.kind);
    if (tg.error) return { status: 400, body: { error: tg.error } };
    Object.assign(patch, tg);
  }
  // Amount and method only change on gifts we recorded by hand; card money is whatever the processor took.
  if (p.offline) {
    if (b.amount_cents != null) {
      const a = intOrNull(b.amount_cents);
      if (a == null || a < 100 || a > LIMITS.maxFlatCents) return { status: 400, body: { error: 'bad_amount' } };
      Object.assign(patch, { amount_cents: a, amount_paid_cents: a, flat_cents: a });
    }
    if (b.method != null && OFFLINE_METHODS[b.method]) patch.paid_via = OFFLINE_METHODS[b.method];
    if (b.check_no != null) patch.check_no = stripTags(clip(b.check_no, 40)).trim();
  }
  patch.edited_at = new Date().toISOString();
  const w = await fsPatchVerified(`pledges/${b.id}`, patch);
  if (!w.ok) return { status: 502, body: { error: 'save_failed' } };
  return { status: 200, body: { ok: true } };
}

// Hide, never hard delete: the record stays in the database and Restore brings it back.
// Card money can't be hidden (refund it instead), so totals always match the processor.
async function actionRemove(b) {
  if (!safeId(b && b.id)) return { status: 400, body: { error: 'bad_id' } };
  const p = await fsGet(`pledges/${b.id}`);
  if (!p) return { status: 404, body: { error: 'not_found' } };
  if (p.status === 'removed') return { status: 200, body: { ok: true, already: true } };
  if (p.status === 'paid' && !p.offline) return { status: 400, body: { error: 'paid_by_card' } };
  // Stripe checkout links expire after 24 hours, so a 'pending' older than that was abandoned.
  const staleCheckout = p.status === 'pending' && Date.now() - Date.parse(p.created || 0) > 864e5;
  if (p.status === 'invoiced' || (p.status === 'pending' && !staleCheckout)) return { status: 400, body: { error: 'payment_in_flight' } };
  const w = await fsPatchVerified(`pledges/${b.id}`, { status: 'removed', status_before_remove: p.status || '', removed_at: new Date().toISOString() });
  if (!w.ok) return { status: 502, body: { error: 'save_failed' } };
  return { status: 200, body: { ok: true } };
}
async function actionRestore(b) {
  if (!safeId(b && b.id)) return { status: 400, body: { error: 'bad_id' } };
  const p = await fsGet(`pledges/${b.id}`);
  if (!p) return { status: 404, body: { error: 'not_found' } };
  if (p.status !== 'removed') return { status: 400, body: { error: 'not_removed' } };
  const w = await fsPatchVerified(`pledges/${b.id}`, { status: p.status_before_remove || 'canceled', removed_at: '' });
  if (!w.ok) return { status: 502, body: { error: 'save_failed' } };
  return { status: 200, body: { ok: true } };
}

async function sendReceipt(p) {
  if (!p.donor_email || !emailConfigured()) return false;
  const { subject, html } = buildDonationReceiptEmail(p);
  return sendMail({ to: p.donor_email, subject, html, bcc: ADMIN_EMAIL });
}

async function actionAddOffline(b) {
  const event = await loadEvent();
  if (!event) return { status: 400, body: { error: 'no_event' } };
  const donor = cleanDonor(Object.assign({ donor_name: '', donor_email: '' }, b), false);
  if (donor.error) return { status: 400, body: { error: donor.error } };
  const tg = cleanTarget(event, b, 'flat');
  if (tg.error) return { status: 400, body: { error: tg.error } };
  const a = intOrNull(b && b.amount_cents);
  if (a == null || a < 100 || a > LIMITS.maxFlatCents) return { status: 400, body: { error: 'bad_amount' } };
  const method = OFFLINE_METHODS[b.method] || 'Cash';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? new Date(b.date + 'T12:00:00Z').toISOString() : new Date().toISOString();
  const doc = Object.assign({
    event_id: SHOOTATHON.eventId, site: SITE_TAG, kind: 'flat', offline: true,
    flat_cents: a, per_shot_cents: 0, cap_cents: 0, cover_fee: false, fee_cents: 0,
    amount_cents: a, amount_paid_cents: a, status: 'paid', paid_via: method,
    check_no: stripTags(clip(b.check_no, 40)).trim(), created: day, paid_at: day,
    message: '', anonymous: false, note: '',
  }, donor, tg);
  const created = await fsCreate('pledges', doc);
  const id = created && created.name ? String(created.name).split('/').pop() : null;
  if (!id) return { status: 502, body: { error: 'save_failed' } };
  let emailed = false;
  if (b.send_receipt) { try { emailed = await sendReceipt(Object.assign({ id }, doc)); } catch (e) { /* gift is saved either way */ } }
  return { status: 200, body: { ok: true, id, emailed } };
}

// A per-throw pledge settled outside the pay-link (handed a check after the event, say).
async function actionMarkPaid(b) {
  if (!safeId(b && b.id)) return { status: 400, body: { error: 'bad_id' } };
  const p = await fsGet(`pledges/${b.id}`);
  if (!p) return { status: 404, body: { error: 'not_found' } };
  if (p.status !== 'pledged' && p.status !== 'invoiced') return { status: 400, body: { error: 'not_open' } };
  let amount = p.status === 'invoiced' ? (p.amount_cents || 0) : 0;
  if (!amount) {
    const event = await loadEvent();
    const tg = targetOf(p);
    amount = computePledgeCents(p, tg.type === 'player' ? (makesMap(event)[tg.slug] || 0) : null);
  }
  if (b.amount_cents != null) { const a = intOrNull(b.amount_cents); if (a != null && a > 0) amount = a; }
  if (amount <= 0) return { status: 400, body: { error: 'nothing_owed' } };
  const now = new Date().toISOString();
  const patch = { status: 'paid', offline: true, paid_via: OFFLINE_METHODS[b.method] || 'Cash', check_no: stripTags(clip(b.check_no, 40)).trim(), amount_cents: amount, amount_paid_cents: amount, paid_at: now };
  const w = await fsPatchVerified(`pledges/${b.id}`, patch);
  if (!w.ok) return { status: 502, body: { error: 'save_failed' } };
  let emailed = false;
  if (b.send_receipt) { try { emailed = await sendReceipt(Object.assign({}, p, patch)); } catch (e) { /* saved either way */ } }
  return { status: 200, body: { ok: true, emailed } };
}

async function actionReceipt(b) {
  if (!safeId(b && b.id)) return { status: 400, body: { error: 'bad_id' } };
  if (!emailConfigured()) return { status: 503, body: { error: 'email_not_configured' } };
  const p = await fsGet(`pledges/${b.id}`);
  if (!p) return { status: 404, body: { error: 'not_found' } };
  if (p.status !== 'paid') return { status: 400, body: { error: 'not_paid' } };
  if (!p.donor_email) return { status: 400, body: { error: 'no_email' } };
  const ok = await sendReceipt(p);
  return { status: ok ? 200 : 502, body: ok ? { ok: true } : { error: 'send_failed' } };
}

async function actionSync() {
  const pledges = await loadPledges();
  let checked = 0, paid = 0;
  for (const p of pledges) {
    if (p.status !== 'invoiced' && p.status !== 'pending') continue;  // pending = an in-flight one-time donation
    checked++;
    try { const v = await verifyPayment(p); if (v.paid) { await finalizeDonationPaid(p.id, p, v.patch); paid++; } } catch (e) { /* best-effort */ }
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
    if (action === 'refund') { const r = await actionRefund(b); return res.status(r.status).json(r.body); }
    if (action === 'edit') { const r = await actionEdit(b); return res.status(r.status).json(r.body); }
    if (action === 'remove') { const r = await actionRemove(b); return res.status(r.status).json(r.body); }
    if (action === 'restore') { const r = await actionRestore(b); return res.status(r.status).json(r.body); }
    if (action === 'add_offline') { const r = await actionAddOffline(b); return res.status(r.status).json(r.body); }
    if (action === 'mark_paid') { const r = await actionMarkPaid(b); return res.status(r.status).json(r.body); }
    if (action === 'receipt') { const r = await actionReceipt(b); return res.status(r.status).json(r.body); }
    if (action === 'sync') { const r = await actionSync(); return res.status(r.status).json(r.body); }
    return res.status(400).json({ error: 'unknown_action' });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
}
