// Offline tests for the Shoot-a-Thon (free-throw fundraiser). Pure-logic checks for the
// authoritative amount computation + target validation + emails, then the REAL handlers run
// end-to-end against the in-memory Firestore / Stripe / SendGrid fakes: one-time donation paid
// NOW, per-throw pledge billed AFTER, and the org/team/player roll-up totals. Zero network.
// Run: npm test   (or: node tests/shootathon.test.mjs)

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as fake from './_fake.js';
import { computePledgeCents, normalizePledge, pledgeDescription, coverFeeCents, LIMITS, SHOOTATHON } from '../api/_shootathon.js';
import { buildPledgeEmail, buildPayLinkEmail, buildDonationReceiptEmail } from '../api/_email.js';
import pledge from '../api/pledge.js';
import shootathon from '../api/shootathon.js';
import webhook from '../api/webhook-stripe.js';
import { SITE_TAG } from '../api/_site.js';

fake.install();

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => fake.assertClean()).then(
    () => { pass++; console.log('  ✓', name); },
    (e) => { fail++; console.log('  ✗', name, '\n       ', String(e && e.message || e).split('\n').join('\n       ')); }
  );
}
function group(title) { fake.reset(); console.log('\n' + title); }
function mockRes() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (j) => { r.body = j; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.end = () => r;
  return r;
}
function mockReq(o) { return Object.assign({ method: 'GET', headers: {}, query: {}, body: {} }, o); }
async function call(handler, o) { const res = mockRes(); await handler(mockReq(o), res); return res; }

const ADMIN = { 'x-admin-key': process.env.ADMIN_PASSWORD };
const EVENT_PATH = `shootathon/${SHOOTATHON.eventId}`;
function sign(raw, secret = process.env.STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex')}`;
}
function donationEvent(pledgeId, sessionId) {
  return JSON.stringify({ id: 'evt_' + pledgeId, object: 'event', type: 'checkout.session.completed', data: { object: { id: sessionId, object: 'checkout.session', client_reference_id: pledgeId, metadata: { kind: 'donation', pledge_id: pledgeId, site: SITE_TAG }, payment_status: 'paid' } } });
}
async function deliverWebhook(pledgeId, sessionId) {
  const raw = donationEvent(pledgeId, sessionId);
  return call(webhook, { method: 'POST', headers: { 'stripe-signature': sign(raw), 'content-type': 'application/json' }, body: raw });
}
function seedEvent(over = {}) {
  fake.seed(EVENT_PATH, Object.assign({
    title: 'Aces Shoot-a-Thon', open: true, org_goal_cents: 3000000,
    teams: [{ slug: 'varsity', name: 'Varsity', goal_cents: 1000000 }, { slug: 'jv', name: 'JV', goal_cents: 1000000 }],
    players: [
      { slug: 'jimmy-d', name: 'Jimmy D', team: 'varsity', goal_cents: 100000, makes: 0 },
      { slug: 'sara-k', name: 'Sara K', team: 'jv', goal_cents: 100000, makes: 0 },
    ],
  }, over));
}
const okPer = { kind: 'per_shot', target_type: 'player', target_slug: 'jimmy-d', per_shot_cents: 50, cap_cents: 10000, donor_name: 'Pat Q', donor_email: 'pat@x.com' };
const okFlatPlayer = { kind: 'flat', target_type: 'player', target_slug: 'jimmy-d', flat_cents: 5000, donor_name: 'Dana R', donor_email: 'dana@x.com' };
const okFlatOrg = { kind: 'flat', target_type: 'org', flat_cents: 10000, donor_name: 'Sam D', donor_email: 'sam@x.com' };

// ════════════════════════════════════════════════════════════════════════
group('computePledgeCents — authoritative');
await test('per-throw = rate × makes', () => assert.equal(computePledgeCents({ kind: 'per_shot', per_shot_cents: 50 }, 84), 4200));
await test('cap limits the total', () => assert.equal(computePledgeCents({ kind: 'per_shot', per_shot_cents: 50, cap_cents: 2000 }, 84), 2000));
await test('flat = the gift', () => assert.equal(computePledgeCents({ kind: 'flat', flat_cents: 10000 }, null), 10000));
await test('makes clamped to maxMakes', () => assert.equal(computePledgeCents({ kind: 'per_shot', per_shot_cents: 100 }, 99999), 100 * LIMITS.maxMakes));
await test('per-throw rate clamped to the $10 ceiling', () => assert.equal(computePledgeCents({ kind: 'per_shot', per_shot_cents: 99999 }, 2), LIMITS.maxPerShotCents * 2));
await test('0 makes → $0', () => assert.equal(computePledgeCents({ kind: 'per_shot', per_shot_cents: 500 }, 0), 0));

group('normalizePledge — targets + validation');
await test('per-throw pledge on a player', () => { const r = normalizePledge(okPer); assert.ok(r.ok); assert.equal(r.pledge.target_type, 'player'); assert.equal(r.pledge.target_slug, 'jimmy-d'); });
await test('one-time gift to a player', () => { const r = normalizePledge(okFlatPlayer); assert.ok(r.ok); assert.equal(r.pledge.flat_cents, 5000); });
await test('one-time gift to the org', () => { const r = normalizePledge(okFlatOrg); assert.ok(r.ok); assert.equal(r.pledge.target_type, 'org'); });
await test('one-time gift to a team', () => { const r = normalizePledge({ kind: 'flat', target_type: 'team', target_slug: 'varsity', flat_cents: 5000, donor_name: 'A', donor_email: 'a@x.com' }); assert.ok(r.ok); assert.equal(r.pledge.target_type, 'team'); });
await test('per-throw to the org is rejected', () => assert.equal(normalizePledge({ ...okPer, target_type: 'org', target_slug: '' }).error, 'per_shot_needs_player'));
await test('honeypot rejects bots', () => assert.equal(normalizePledge({ ...okPer, company: 'Bot' }).error, 'spam'));
await test('bad email rejected', () => assert.equal(normalizePledge({ ...okPer, donor_email: 'nope' }).error, 'bad_email'));
await test('flat below minimum rejected', () => assert.equal(normalizePledge({ ...okFlatOrg, flat_cents: 100 }).error, 'bad_amount'));
await test('per-throw above $10 rejected', () => assert.equal(normalizePledge({ ...okPer, per_shot_cents: 2000 }).error, 'bad_per_shot'));
await test('malformed target slug rejected', () => assert.equal(normalizePledge({ ...okPer, target_slug: 'bad slug!' }).error, 'bad_target'));
await test('strips HTML from donor name', () => { const r = normalizePledge({ ...okPer, donor_name: 'Al<script>x' }); assert.ok(r.ok); assert.ok(!/[<>]/.test(r.pledge.donor_name)); });

group('emails');
await test('pledge email names the player + nothing charged yet', () => { const { subject, html } = buildPledgeEmail({ kind: 'per_shot', per_shot_cents: 50, cap_cents: 10000 }, 'Jimmy D'); assert.match(subject, /pledge/i); assert.match(html, /Jimmy D/); assert.match(html, /Nothing has been charged yet/i); assert.match(html, /free throw/i); });
await test('pay-link email shows total + button', () => { const { html } = buildPayLinkEmail({ kind: 'per_shot', per_shot_cents: 50, amount_cents: 4200 }, 'Jimmy D', 'https://dba.test/donate-pay.html?p=abc', 84); assert.match(html, /\$42\.00/); assert.match(html, /donate-pay\.html\?p=abc/); assert.match(html, /84/); });
await test('receipt email: amount + neutral booster footer (no tax claim)', () => { const { html } = buildDonationReceiptEmail({ id: 'p1', amount_paid_cents: 5000, paid_via: 'Stripe', card_last4: '4242' }); assert.match(html, /\$50\.00/); assert.match(html, /remitted in full/i); assert.doesNotMatch(html, /tax-deductible/i); assert.doesNotMatch(html, /501\(c\)\(3\)/); });
await test('description reads naturally', () => { assert.equal(pledgeDescription({ kind: 'per_shot', per_shot_cents: 50, cap_cents: 10000 }), '$0.50 per made free throw (up to $100.00)'); assert.equal(pledgeDescription({ kind: 'flat', flat_cents: 10000 }), '$100.00 one-time donation'); });

// ════════════════════════════════════════════════════════════════════════
group('public GET — snapshot with goals + roll-up');
await test('no event → {open:false}', async () => { const r = await call(pledge, {}); assert.equal(r.body.open, false); });
await test('open event → org/team/player goals, 0 raised', async () => {
  fake.reset(); seedEvent();
  const r = await call(pledge, {});
  assert.equal(r.body.open, true);
  assert.equal(r.body.org.goal_cents, 3000000);
  assert.equal(r.body.teams.length, 2);
  assert.equal(r.body.players.find((p) => p.slug === 'jimmy-d').goal_cents, 100000);
  assert.equal(r.body.org.raised_cents, 0);
  assert.ok(!JSON.stringify(r.body).includes('@'), 'no donor emails leak');
});

group('one-time donation → paid NOW → rolls up to player + team + org');
await test('flat gift to a player: checkout now, webhook finalizes, totals roll up', async () => {
  fake.reset(); seedEvent();
  const r = await call(pledge, { method: 'POST', body: { ...okFlatPlayer } });
  assert.equal(r.statusCode, 200); assert.equal(r.body.pay, true); assert.ok(r.body.url); assert.ok(r.body.id);
  const d = fake.doc('pledges/' + r.body.id);
  assert.equal(d.status, 'pending'); assert.equal(d.amount_cents, 5000); assert.equal(d.target_type, 'player');
  const sessionId = d.stripe_session_id;
  assert.equal(fake.stripe.session(sessionId).amount_total, 5000);
  fake.stripe.pay(sessionId, { last4: '4242' });
  const wh = await deliverWebhook(r.body.id, sessionId);
  assert.equal(wh.body.donation_finalized, true);
  assert.equal(fake.doc('pledges/' + r.body.id).status, 'paid');
  assert.ok(fake.mailsTo('dana@x.com').some((m) => /Donation received/i.test(m.subject)), 'receipt emailed');
  // roll-up: $50 shows on Jimmy ($1k), Varsity ($10k), and the org ($30k)
  const snap = (await call(pledge, {})).body;
  assert.equal(snap.players.find((p) => p.slug === 'jimmy-d').raised_cents, 5000);
  assert.equal(snap.teams.find((t) => t.slug === 'varsity').raised_cents, 5000);
  assert.equal(snap.teams.find((t) => t.slug === 'jv').raised_cents, 0);
  assert.equal(snap.org.raised_cents, 5000);
});
await test('flat gift to the org: counts for the org only', async () => {
  fake.reset(); seedEvent();
  const id = (await call(pledge, { method: 'POST', body: { ...okFlatOrg } })).body.id;
  fake.stripe.pay(fake.doc('pledges/' + id).stripe_session_id);
  await deliverWebhook(id, fake.doc('pledges/' + id).stripe_session_id);
  const snap = (await call(pledge, {})).body;
  assert.equal(snap.org.raised_cents, 10000);
  assert.equal(snap.teams.find((t) => t.slug === 'varsity').raised_cents, 0);
});
await test('unknown player rejected; unknown team rejected', async () => {
  fake.reset(); seedEvent();
  assert.equal((await call(pledge, { method: 'POST', body: { ...okFlatPlayer, target_slug: 'nobody' } })).body.error, 'unknown_player');
  assert.equal((await call(pledge, { method: 'POST', body: { kind: 'flat', target_type: 'team', target_slug: 'ghost', flat_cents: 5000, donor_name: 'A', donor_email: 'a@x.com' } })).body.error, 'unknown_team');
});
await test('closed event → 503', async () => { fake.reset(); seedEvent({ open: false }); assert.equal((await call(pledge, { method: 'POST', body: { ...okFlatOrg } })).statusCode, 503); });

group('per-throw pledge → billed AFTER the event');
await test('pledge now (no charge) → makes → pay-link → pay → paid → rolls up', async () => {
  fake.reset(); seedEvent();
  const pr = await call(pledge, { method: 'POST', body: { ...okPer } });
  assert.equal(pr.body.pledged, true);
  const id = pr.body.id;
  assert.equal(fake.doc('pledges/' + id).status, 'pledged');
  assert.ok(fake.mailsTo('pat@x.com').some((m) => /pledge/i.test(m.subject)), 'pledge email');
  // enter makes + send links
  await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'set_makes', makes: { 'jimmy-d': 84 } } });
  const sl = await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'send_links' } });
  assert.equal(sl.body.invoiced, 1); assert.equal(sl.body.emailed, 1);
  assert.equal(fake.doc('pledges/' + id).amount_cents, 4200);
  // donor pays
  await call(pledge, { query: { pay: id } });
  const sessionId = fake.doc('pledges/' + id).stripe_session_id;
  fake.stripe.pay(sessionId);
  await deliverWebhook(id, sessionId);
  assert.equal(fake.doc('pledges/' + id).status, 'paid');
  const snap = (await call(pledge, {})).body;
  assert.equal(snap.org.raised_cents, 4200);
  assert.equal(snap.players.find((p) => p.slug === 'jimmy-d').raised_cents, 4200);
});
await test('player with 0 makes → no_charge, not invoiced', async () => {
  fake.reset(); seedEvent();
  const id = (await call(pledge, { method: 'POST', body: { ...okPer } })).body.id;
  const sl = await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'send_links' } });
  assert.equal(sl.body.zero, 1); assert.equal(sl.body.invoiced, 0);
  assert.equal(fake.doc('pledges/' + id).status, 'no_charge');
});

group('admin — auth + config');
await test('missing key → 401', async () => assert.equal((await call(shootathon, { method: 'POST', body: { action: 'config' } })).statusCode, 401));
await test('config returns teams, players, totals', async () => {
  fake.reset(); seedEvent();
  const r = await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'config' } });
  assert.equal(r.body.event.teams.length, 2);
  assert.equal(r.body.event.org_goal_cents, 3000000);
  assert.equal(r.body.event.players.find((p) => p.slug === 'jimmy-d').team, 'varsity');
});
await test('set_event creates teams + players with goals; makes preserved on edit', async () => {
  fake.reset();
  await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'set_event', title: 'Aces Shoot-a-Thon', open: true, org_goal_cents: 3000000, teams: [{ name: 'Varsity', goal_cents: 1000000 }], players: [{ name: 'Jimmy D', team: 'varsity', goal_cents: 100000 }] } });
  let ev = fake.doc(EVENT_PATH);
  assert.equal(ev.teams[0].slug, 'varsity');
  assert.equal(ev.players[0].goal_cents, 100000);
  await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'set_makes', makes: { 'jimmy-d': 50 } } });
  // re-save the roster (e.g. renamed) → makes should survive
  await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'set_event', players: [{ slug: 'jimmy-d', name: 'Jimmy Dee', team: 'varsity' }] } });
  assert.equal(fake.doc(EVENT_PATH).players[0].makes, 50);
});

group('cover-the-fee + event story');
await test('coverFeeCents grosses up so the club nets the gift', () => {
  const fee = coverFeeCents(5000); // $50 gift
  assert.ok(fee > 150 && fee < 220, 'fee ~ $1.81 for a $50 gift, got ' + fee);
  const charged = 5000 + fee;
  assert.ok((charged - fee) === 5000, 'net to club = the gift');
});
await test('normalizePledge captures cover_fee', () => { assert.equal(normalizePledge({ ...okFlatOrg, cover_fee: true }).pledge.cover_fee, true); assert.equal(normalizePledge(okFlatOrg).pledge.cover_fee, false); });
await test('flat gift with cover_fee charges base+fee; thermometer shows the base (net)', async () => {
  fake.reset(); seedEvent();
  const r = await call(pledge, { method: 'POST', body: { ...okFlatPlayer, cover_fee: true } }); // $50 to Jimmy
  const d = fake.doc('pledges/' + r.body.id);
  const fee = coverFeeCents(5000);
  assert.equal(d.fee_cents, fee);
  assert.equal(d.amount_cents, 5000 + fee);
  assert.equal(fake.stripe.session(d.stripe_session_id).amount_total, 5000 + fee);
  fake.stripe.pay(d.stripe_session_id);
  await deliverWebhook(r.body.id, d.stripe_session_id);
  const snap = (await call(pledge, {})).body;
  assert.equal(snap.players.find((p) => p.slug === 'jimmy-d').raised_cents, 5000); // net of the covered fee
  assert.equal(snap.org.raised_cents, 5000);
});
await test('set_event stores event date + about; snapshot returns them', async () => {
  fake.reset(); seedEvent();
  await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'set_event', event_date: '2026-12-15', about: 'Every athlete shoots 100 free throws.' } });
  const cfg = await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'config' } });
  assert.equal(cfg.body.event.event_date, '2026-12-15');
  const snap = (await call(pledge, {})).body;
  assert.equal(snap.event_date, '2026-12-15');
  assert.match(snap.about, /100 free throws/);
});
await test('set_event rejects a malformed event date (stored blank)', async () => {
  fake.reset(); seedEvent();
  await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'set_event', event_date: 'not-a-date' } });
  assert.equal(fake.doc(EVENT_PATH).event_date, '');
});

group('admin refund of a paid donation');
async function paidOrgGift() {
  fake.reset(); seedEvent();
  const id = (await call(pledge, { method: 'POST', body: { ...okFlatOrg } })).body.id;
  const sid = fake.doc('pledges/' + id).stripe_session_id;
  fake.stripe.pay(sid, { last4: '4242' });
  await deliverWebhook(id, sid);
  assert.equal(fake.doc('pledges/' + id).status, 'paid');
  return { id, sid };
}
await test('refund: money back in full, off the totals and the wall, donor emailed', async () => {
  const { id } = await paidOrgGift();
  const r = await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'refund', id } });
  assert.equal(r.statusCode, 200); assert.equal(r.body.refunded_cents, 10000);
  assert.equal(fake.state.stripe.refunds.length, 1); assert.equal(fake.state.stripe.refunds[0].amount, 10000);
  const d = fake.doc('pledges/' + id);
  assert.equal(d.status, 'refunded'); assert.equal(d.amount_refunded_cents, 10000);
  const snap = (await call(pledge, {})).body;
  assert.equal(snap.org.raised_cents, 0); assert.equal(snap.supporter_count, 0);
  assert.ok(fake.mailsTo('sam@x.com').some((m) => /refunded/i.test(m.subject)), 'refund email sent');
  const cfg = (await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'config' } })).body;
  assert.equal(cfg.totals.raised_cents, 0); assert.equal(cfg.totals.refunded_cents, 10000); assert.equal(cfg.totals.pledges, 0);
});
await test('refund: a second click is refused, Stripe is called once', async () => {
  const { id } = await paidOrgGift();
  await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'refund', id } });
  const again = await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'refund', id } });
  assert.equal(again.statusCode, 400); assert.equal(again.body.error, 'already_refunded');
  assert.equal(fake.state.stripe.refunds.length, 1);
});
await test('refund: a late webhook replay does not flip it back to paid', async () => {
  const { id, sid } = await paidOrgGift();
  await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'refund', id } });
  const wh = await deliverWebhook(id, sid);
  assert.equal(wh.statusCode, 200);
  assert.equal(fake.doc('pledges/' + id).status, 'refunded');
  assert.equal((await call(pledge, {})).body.org.raised_cents, 0);
});
await test('refund: an unpaid pledge cannot be refunded', async () => {
  fake.reset(); seedEvent();
  const id = (await call(pledge, { method: 'POST', body: { ...okPer } })).body.id;
  const r = await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'refund', id } });
  assert.equal(r.statusCode, 400); assert.equal(r.body.error, 'not_paid');
  assert.equal(fake.state.stripe.refunds.length, 0);
});
await test('refund: needs the admin passcode', async () => {
  const { id } = await paidOrgGift();
  assert.equal((await call(shootathon, { method: 'POST', body: { action: 'refund', id } })).statusCode, 401);
  assert.equal(fake.state.stripe.refunds.length, 0);
});

group('admin: cash/check gifts, edit, remove, restore, mark paid, receipt');
const adm = (body) => call(shootathon, { method: 'POST', headers: ADMIN, body });
await test('cash gift counts toward player, team and org; receipt optional', async () => {
  fake.reset(); seedEvent();
  const r = await adm({ action: 'add_offline', donor_name: 'Grandma Jo', donor_email: 'jo@x.com', target_type: 'player', target_slug: 'jimmy-d', amount_cents: 2000, method: 'check', check_no: '1042', send_receipt: true });
  assert.equal(r.statusCode, 200); assert.ok(r.body.id); assert.equal(r.body.emailed, true);
  const d = fake.doc('pledges/' + r.body.id);
  assert.equal(d.status, 'paid'); assert.equal(d.offline, true); assert.equal(d.paid_via, 'Check'); assert.equal(d.check_no, '1042');
  const snap = (await call(pledge, {})).body;
  assert.equal(snap.players.find((p) => p.slug === 'jimmy-d').raised_cents, 2000);
  assert.equal(snap.teams.find((t) => t.slug === 'varsity').raised_cents, 2000);
  assert.equal(snap.org.raised_cents, 2000);
  assert.ok(fake.mailsTo('jo@x.com').some((m) => /Donation received/i.test(m.subject)));
});
await test('cash gift needs a name and a real amount; email is optional', async () => {
  fake.reset(); seedEvent();
  assert.equal((await adm({ action: 'add_offline', donor_name: '', amount_cents: 2000 })).body.error, 'missing_name');
  assert.equal((await adm({ action: 'add_offline', donor_name: 'A', amount_cents: 0 })).body.error, 'bad_amount');
  assert.equal((await adm({ action: 'add_offline', donor_name: 'A', amount_cents: 2000, target_type: 'player', target_slug: 'nobody' })).body.error, 'unknown_player');
  assert.equal((await adm({ action: 'add_offline', donor_name: 'A', amount_cents: 2000 })).statusCode, 200);
});
await test('edit fixes donor info and moves a gift to another player; card amount stays put', async () => {
  const { id } = await paidOrgGift();
  const r = await adm({ action: 'edit', id, donor_name: 'Sam Davis', donor_email: 'SAMD@x.com', anonymous: true, target_type: 'player', target_slug: 'sara-k', amount_cents: 1 });
  assert.equal(r.statusCode, 200);
  const d = fake.doc('pledges/' + id);
  assert.equal(d.donor_name, 'Sam Davis'); assert.equal(d.donor_email, 'samd@x.com'); assert.equal(d.anonymous, true);
  assert.equal(d.target_slug, 'sara-k'); assert.equal(d.amount_paid_cents, 10000);
  const snap = (await call(pledge, {})).body;
  assert.equal(snap.players.find((p) => p.slug === 'sara-k').raised_cents, 10000);
  assert.equal(snap.teams.find((t) => t.slug === 'jv').raised_cents, 10000);
});
await test('edit can change a cash gift amount and method', async () => {
  fake.reset(); seedEvent();
  const id = (await adm({ action: 'add_offline', donor_name: 'A', amount_cents: 2000 })).body.id;
  await adm({ action: 'edit', id, amount_cents: 2500, method: 'venmo' });
  const d = fake.doc('pledges/' + id); assert.equal(d.amount_paid_cents, 2500); assert.equal(d.paid_via, 'Venmo');
});
await test('remove hides an unpaid pledge everywhere; restore brings it back', async () => {
  fake.reset(); seedEvent();
  const id = (await call(pledge, { method: 'POST', body: { ...okPer } })).body.id;
  assert.equal((await call(pledge, {})).body.supporter_count, 1);
  assert.equal((await adm({ action: 'remove', id })).statusCode, 200);
  assert.equal(fake.doc('pledges/' + id).status, 'removed');
  assert.equal((await call(pledge, {})).body.supporter_count, 0);
  assert.equal((await adm({ action: 'config' })).body.totals.pledges, 0);
  assert.equal((await adm({ action: 'restore', id })).statusCode, 200);
  assert.equal(fake.doc('pledges/' + id).status, 'pledged');
});
await test('remove refuses card money and payments in flight', async () => {
  const { id } = await paidOrgGift();
  assert.equal((await adm({ action: 'remove', id })).body.error, 'paid_by_card');
  fake.reset(); seedEvent();
  const pend = (await call(pledge, { method: 'POST', body: { ...okFlatOrg } })).body.id;
  assert.equal((await adm({ action: 'remove', id: pend })).body.error, 'payment_in_flight');
});
await test('remove takes an abandoned checkout older than a day', async () => {
  fake.reset(); seedEvent();
  const pend = (await call(pledge, { method: 'POST', body: { ...okFlatOrg } })).body.id;
  fake.seed('pledges/' + pend, Object.assign({}, fake.doc('pledges/' + pend), { created: new Date(Date.now() - 2 * 864e5).toISOString() }));
  assert.equal((await adm({ action: 'remove', id: pend })).statusCode, 200);
  assert.equal(fake.doc('pledges/' + pend).status, 'removed');
});
await test('mark paid settles a per-throw pledge by check at the made-throw total', async () => {
  fake.reset(); seedEvent({ players: [{ slug: 'jimmy-d', name: 'Jimmy D', team: 'varsity', goal_cents: 100000, makes: 84 }] });
  const id = (await call(pledge, { method: 'POST', body: { ...okPer } })).body.id;
  const r = await adm({ action: 'mark_paid', id, method: 'check' });
  assert.equal(r.statusCode, 200);
  const d = fake.doc('pledges/' + id); assert.equal(d.status, 'paid'); assert.equal(d.amount_paid_cents, 4200); assert.equal(d.paid_via, 'Check');
  assert.equal((await call(pledge, {})).body.org.raised_cents, 4200);
});
await test('receipt re-sends for a paid gift only', async () => {
  const { id } = await paidOrgGift();
  const before = fake.mailsTo('sam@x.com').length;
  assert.equal((await adm({ action: 'receipt', id })).statusCode, 200);
  assert.equal(fake.mailsTo('sam@x.com').length, before + 1);
  fake.reset(); seedEvent();
  const open = (await call(pledge, { method: 'POST', body: { ...okPer } })).body.id;
  assert.equal((await adm({ action: 'receipt', id: open })).body.error, 'not_paid');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
