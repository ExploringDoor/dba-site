// Offline tests for the Shoot-a-Thon (donations). Pure-logic checks for the authoritative
// amount computation + pledge validation + emails, then the REAL handlers run end-to-end against
// the in-memory Firestore / Stripe / SendGrid fakes: pledge → enter makes → send pay-link →
// donor pays → webhook → receipt. Zero network.
// Run: npm test   (or: node tests/shootathon.test.mjs)

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as fake from './_fake.js';
import { computePledgeCents, normalizePledge, pledgeDescription, LIMITS, SHOOTATHON } from '../api/_shootathon.js';
import { buildPledgeEmail, buildPayLinkEmail, buildDonationReceiptEmail } from '../api/_email.js';
import pledge from '../api/pledge.js';
import shootathon from '../api/shootathon.js';
import webhook from '../api/webhook-stripe.js';

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
const sid = (res) => String(res.headers.Location || '').split('/').pop();
function sign(raw, secret = process.env.STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex')}`;
}
function donationEvent(pledgeId, sessionId) {
  return JSON.stringify({ id: 'evt_' + pledgeId, object: 'event', type: 'checkout.session.completed', data: { object: { id: sessionId, object: 'checkout.session', client_reference_id: pledgeId, metadata: { kind: 'donation', pledge_id: pledgeId }, payment_status: 'paid' } } });
}
async function deliverWebhook(pledgeId, sessionId) {
  const raw = donationEvent(pledgeId, sessionId);
  return call(webhook, { method: 'POST', headers: { 'stripe-signature': sign(raw), 'content-type': 'application/json' }, body: raw });
}
function seedEvent(over = {}) {
  fake.seed(EVENT_PATH, Object.assign({ title: 'DBA Shoot-a-Thon 2026', open: true, goal_cents: 500000, players: [{ slug: 'jimmy-d', name: 'Jimmy D', makes: 0 }, { slug: 'sara-k', name: 'Sara K', makes: 0 }] }, over));
}

// ════════════════════════════════════════════════════════════════════════
group('computePledgeCents — authoritative, never trusts the browser');
await test('per-shot = rate × makes', () => assert.equal(computePledgeCents({ kind: 'per_shot', per_shot_cents: 50 }, 84), 50 * 84));
await test('cap limits the total', () => assert.equal(computePledgeCents({ kind: 'per_shot', per_shot_cents: 50, cap_cents: 2000 }, 84), 2000));
await test('cap of 0 means no cap', () => assert.equal(computePledgeCents({ kind: 'per_shot', per_shot_cents: 50, cap_cents: 0 }, 100), 5000));
await test('flat = the flat gift', () => assert.equal(computePledgeCents({ kind: 'flat', flat_cents: 30000 }, null), 30000));
await test('makes clamped to maxMakes', () => assert.equal(computePledgeCents({ kind: 'per_shot', per_shot_cents: 100 }, 99999), 100 * LIMITS.maxMakes));
await test('per-shot below minimum → 0 (never invoiced)', () => assert.equal(computePledgeCents({ kind: 'per_shot', per_shot_cents: 1 }, 50), 0));
await test('0 makes → $0', () => assert.equal(computePledgeCents({ kind: 'per_shot', per_shot_cents: 500 }, 0), 0));
await test('per-shot rate clamped to ceiling before multiply', () => assert.equal(computePledgeCents({ kind: 'per_shot', per_shot_cents: 999999 }, 2), LIMITS.maxPerShotCents * 2));
await test('single charge hard-capped at maxChargeCents', () => assert.ok(computePledgeCents({ kind: 'flat', flat_cents: 99999999 }, null) <= LIMITS.maxChargeCents));

group('normalizePledge — validation + sanitization');
const okPer = { kind: 'per_shot', player_slug: 'jimmy-d', per_shot_cents: 50, cap_cents: 10000, donor_name: 'Pat Q', donor_email: 'pat@x.com' };
const okFlat = { kind: 'flat', player_slug: 'general', flat_cents: 5000, donor_name: 'Dana R', donor_email: 'dana@x.com' };
await test('accepts a good per-shot pledge', () => { const r = normalizePledge(okPer); assert.ok(r.ok); assert.equal(r.pledge.per_shot_cents, 50); assert.equal(r.pledge.cap_cents, 10000); });
await test('accepts a good flat/general pledge', () => { const r = normalizePledge(okFlat); assert.ok(r.ok); assert.equal(r.pledge.flat_cents, 5000); assert.equal(r.pledge.player_slug, 'general'); });
await test('honeypot rejects bots', () => assert.equal(normalizePledge({ ...okPer, company: 'AcmeBot' }).error, 'spam'));
await test('rejects bad email', () => assert.equal(normalizePledge({ ...okPer, donor_email: 'nope' }).error, 'bad_email'));
await test('rejects missing name', () => assert.equal(normalizePledge({ ...okPer, donor_name: '' }).error, 'missing_name'));
await test('per-shot requires a specific player', () => assert.equal(normalizePledge({ ...okPer, player_slug: 'general' }).error, 'per_shot_needs_player'));
await test('rejects flat below the minimum', () => assert.equal(normalizePledge({ ...okFlat, flat_cents: 100 }).error, 'bad_amount'));
await test('rejects per-shot below the minimum', () => assert.equal(normalizePledge({ ...okPer, per_shot_cents: 1 }).error, 'bad_per_shot'));
await test('rejects a cap smaller than one made shot', () => assert.equal(normalizePledge({ ...okPer, cap_cents: 10 }).error, 'bad_cap'));
await test('strips HTML metacharacters from the donor name', () => { const r = normalizePledge({ ...okPer, donor_name: 'Al<script>ert' }); assert.ok(r.ok); assert.ok(!/[<>]/.test(r.pledge.donor_name)); });
await test('rejects a malformed player slug', () => assert.equal(normalizePledge({ ...okPer, player_slug: 'bad slug!' }).error, 'bad_player'));

group('donation emails');
await test('pledge email names the player + says nothing charged yet', () => { const { subject, html } = buildPledgeEmail({ kind: 'per_shot', player_slug: 'jimmy-d', per_shot_cents: 50, cap_cents: 10000 }, 'Jimmy D'); assert.match(subject, /pledge/i); assert.match(html, /Jimmy D/); assert.match(html, /Nothing has been charged yet/i); assert.match(html, /501\(c\)\(3\)/); });
await test('pay-link email shows the total + the button link', () => { const { html } = buildPayLinkEmail({ kind: 'per_shot', player_slug: 'jimmy-d', per_shot_cents: 50, amount_cents: 4200 }, 'Jimmy D', 'https://dba.test/donate-pay.html?p=abc', 84); assert.match(html, /\$42\.00/); assert.match(html, /donate-pay\.html\?p=abc/); assert.match(html, /84/); });
await test('receipt email states tax-deductible + amount + no goods/services', () => { const { html } = buildDonationReceiptEmail({ id: 'p1', amount_paid_cents: 4200, paid_via: 'Stripe', card_last4: '4242' }); assert.match(html, /\$42\.00/); assert.match(html, /tax-deductible/i); assert.match(html, /No goods or services/i); });
await test('description reads naturally', () => { assert.equal(pledgeDescription({ kind: 'per_shot', per_shot_cents: 50, cap_cents: 10000 }), '$0.50 per made shot (up to $100.00)'); assert.equal(pledgeDescription({ kind: 'flat', flat_cents: 30000 }), '$300.00 one-time gift'); });

// ════════════════════════════════════════════════════════════════════════
group('public GET /api/pledge — config + thermometer');
await test('no event → {open:false}', async () => { const r = await call(pledge, {}); assert.equal(r.statusCode, 200); assert.equal(r.body.open, false); });
await test('open event → players + totals, no PII', async () => {
  fake.reset(); seedEvent();
  const r = await call(pledge, {});
  assert.equal(r.body.open, true);
  assert.equal(r.body.players.length, 2);
  assert.equal(r.body.supporter_count, 0);
  assert.ok(!JSON.stringify(r.body).includes('@'), 'config must not leak donor emails');
});

group('POST /api/pledge — records a pledge, no charge');
let perId = '';
await test('valid per-shot pledge → 200 {ok,id}; stored "pledged"; confirmation emailed', async () => {
  fake.reset(); seedEvent();
  const r = await call(pledge, { method: 'POST', body: { ...okPer } });
  assert.equal(r.statusCode, 200); assert.ok(r.body.id); perId = r.body.id;
  const d = fake.doc('pledges/' + perId);
  assert.equal(d.status, 'pledged'); assert.equal(d.amount_cents, 0); assert.equal(d.per_shot_cents, 50);
  const mail = fake.mailsTo('pat@x.com'); assert.equal(mail.length, 1); assert.match(mail[0].subject, /pledge/i);
  assert.ok(mail[0].bcc.includes(process.env.ADMIN_EMAIL), 'admin is bcc\'d');
});
await test('unknown player → 400', async () => { seedEvent(); const r = await call(pledge, { method: 'POST', body: { ...okPer, player_slug: 'nobody' } }); assert.equal(r.statusCode, 400); assert.equal(r.body.error, 'unknown_player'); });
await test('closed event → 503 closed', async () => { seedEvent({ open: false }); const r = await call(pledge, { method: 'POST', body: { ...okPer } }); assert.equal(r.statusCode, 503); assert.equal(r.body.error, 'closed'); });
await test('tampered amount is ignored — stored rate is the one validated', async () => {
  fake.reset(); seedEvent();
  const r = await call(pledge, { method: 'POST', body: { ...okPer, amount_cents: 1, per_shot_cents: 50 } });
  assert.equal(r.statusCode, 200);
  assert.equal(fake.doc('pledges/' + r.body.id).amount_cents, 0); // never set from the browser
});

group('admin /api/shootathon — auth gate');
await test('missing key → 401', async () => { const r = await call(shootathon, { method: 'POST', body: { action: 'config' } }); assert.equal(r.statusCode, 401); });
await test('wrong key → 401', async () => { const r = await call(shootathon, { method: 'POST', headers: { 'x-admin-key': 'nope' }, body: { action: 'config' } }); assert.equal(r.statusCode, 401); });
await test('GET not allowed', async () => { const r = await call(shootathon, { method: 'GET', headers: ADMIN }); assert.equal(r.statusCode, 405); });

group('full flow — pledge → makes → send link → pay → webhook → receipt');
await test('end-to-end per-shot donation', async () => {
  fake.reset(); seedEvent();
  // 1) two supporters pledge: per-shot on Jimmy, and flat/general
  const p1 = (await call(pledge, { method: 'POST', body: { ...okPer, donor_email: 'pat@x.com' } })).body.id;
  const p2 = (await call(pledge, { method: 'POST', body: { ...okFlat, donor_email: 'dana@x.com' } })).body.id;
  assert.ok(p1 && p2);

  // 2) admin enters makes: Jimmy 84
  const sm = await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'set_makes', makes: { 'jimmy-d': 84 } } });
  assert.equal(sm.statusCode, 200);
  assert.equal(fake.doc(EVENT_PATH).players.find((p) => p.slug === 'jimmy-d').makes, 84);

  // 3) admin sends pay-links
  const sl = await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'send_links' } });
  assert.equal(sl.statusCode, 200);
  assert.equal(sl.body.invoiced, 2);     // per-shot (84×$0.50=$42) + flat ($50)
  assert.equal(sl.body.emailed, 2);
  const d1 = fake.doc('pledges/' + p1);
  assert.equal(d1.status, 'invoiced'); assert.equal(d1.amount_cents, 4200);
  assert.equal(fake.doc('pledges/' + p2).amount_cents, 5000);
  assert.ok(fake.mailsTo('pat@x.com').some((m) => m.html.includes('donate-pay.html?p=' + p1)), 'pay-link emailed');

  // 4) donor opens the pay-link → fresh checkout session, 302 to Stripe
  const pay = await call(pledge, { query: { pay: p1 } });
  assert.equal(pay.statusCode, 302);
  assert.match(pay.headers.Location, /checkout\.stripe\.com/);
  const sessionId = fake.doc('pledges/' + p1).stripe_session_id;
  assert.ok(sessionId, 'session id stored on the pledge');
  assert.equal(fake.stripe.session(sessionId).amount_total, 4200);
  assert.equal(fake.stripe.session(sessionId).metadata.kind, 'donation');

  // 5) donor pays → Stripe webhook finalizes
  fake.stripe.pay(sessionId, { last4: '4242' });
  const wh = await deliverWebhook(p1, sessionId);
  assert.equal(wh.statusCode, 200); assert.equal(wh.body.donation_finalized, true);
  const paid = fake.doc('pledges/' + p1);
  assert.equal(paid.status, 'paid'); assert.equal(paid.amount_paid_cents, 4200); assert.equal(paid.card_last4, '4242');
  assert.ok(fake.mailsTo('pat@x.com').some((m) => /Donation received/i.test(m.subject)), 'receipt emailed');
});
await test('webhook is idempotent — a second delivery sends no second receipt', async () => {
  fake.reset(); seedEvent();
  const p1 = (await call(pledge, { method: 'POST', body: { ...okPer, donor_email: 'pat@x.com' } })).body.id;
  await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'set_makes', makes: { 'jimmy-d': 84 } } });
  await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'send_links' } });
  await call(pledge, { query: { pay: p1 } });
  const sessionId = fake.doc('pledges/' + p1).stripe_session_id;
  fake.stripe.pay(sessionId);
  await deliverWebhook(p1, sessionId);
  const receiptsAfterFirst = fake.mailsTo('pat@x.com').filter((m) => /Donation received/i.test(m.subject)).length;
  const again = await deliverWebhook(p1, sessionId);
  assert.equal(again.body.already, 'paid');
  assert.equal(fake.mailsTo('pat@x.com').filter((m) => /Donation received/i.test(m.subject)).length, receiptsAfterFirst);
});
await test('a player who made 0 shots → pledge marked no_charge, not invoiced', async () => {
  fake.reset(); seedEvent();
  const p1 = (await call(pledge, { method: 'POST', body: { ...okPer } })).body.id; // Jimmy, 0 makes
  const sl = await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'send_links' } });
  assert.equal(sl.body.zero, 1); assert.equal(sl.body.invoiced, 0);
  assert.equal(fake.doc('pledges/' + p1).status, 'no_charge');
});
await test('send_links is idempotent — already-invoiced pledges are skipped', async () => {
  fake.reset(); seedEvent();
  await call(pledge, { method: 'POST', body: { ...okFlat } });
  await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'send_links' } });
  const second = await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'send_links' } });
  assert.equal(second.body.invoiced, 0); assert.equal(second.body.skipped, 1);
});
await test('cancel removes a pledge from the totals; config reports projections', async () => {
  fake.reset(); seedEvent();
  const p1 = (await call(pledge, { method: 'POST', body: { ...okFlat } })).body.id;
  const c = await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'cancel', id: p1 } });
  assert.equal(c.statusCode, 200);
  assert.equal(fake.doc('pledges/' + p1).status, 'canceled');
  const cfg = await call(shootathon, { method: 'POST', headers: ADMIN, body: { action: 'config' } });
  assert.equal(cfg.body.totals.pledges, 0); // the only pledge was canceled
});
await test('pay-link refuses a pledge that is not yet invoiced', async () => {
  fake.reset(); seedEvent();
  const p1 = (await call(pledge, { method: 'POST', body: { ...okPer } })).body.id; // still 'pledged'
  const r = await call(pledge, { query: { pay: p1 } });
  assert.equal(r.statusCode, 302);
  assert.match(r.headers.Location, /e=notready/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
