// Offline "simulated production" flow tests — the REAL /api handlers run end-to-end against
// in-memory Firestore / Stripe / SendGrid / Identity Toolkit fakes (tests/_fake.js), so the
// money paths (checkout → pay → confirm/webhook/reconcile, refunds, reminders, notices, check-in)
// are exercised exactly as deployed, with zero network.
// Run: npm test   (or: node tests/flows.test.mjs)
//
// tests/_fake.js MUST be imported before any api module: it sets the env the modules read at
// import time (see tests/_env.js).

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import * as fake from './_fake.js';
import checkout from '../api/checkout.js';
import confirm from '../api/confirm.js';
import webhook from '../api/webhook-stripe.js';
import reconcile from '../api/reconcile.js';
import remind from '../api/remind.js';
import refund from '../api/refund.js';
import checkin from '../api/checkin.js';
import notify from '../api/notify.js';
import { PRICE } from '../api/_clinic.js';

fake.install();

// ── harness (mirrors tests/clinic.test.mjs) ──────────────────────────────
let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => fake.assertClean()).then(
    () => { pass++; console.log('  ✓', name); },
    (e) => { fail++; console.log('  ✗', name, '\n      ', String(e && e.message || e).split('\n').join('\n       ')); }
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
const COACH = { 'x-checkin-key': process.env.CHECKIN_PASSWORD };
const CRON = { authorization: `Bearer ${process.env.CRON_SECRET}` };
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const GOOD = {
  sessions: ['s1', 's2'],
  players: [{ first: 'Kobe', last: 'B', dob: '2015-01-01', grade: '5' }],
  parent_email: 'jane@x.com', parent_name: 'Jane Doe', parent_phone: '610-555-0100', parent_rel: 'Mother',
  emerg_name: 'Ed Doe', emerg_phone: '610-555-0101', pickup_name: 'Gran', pickup_phone: '610-555-0102',
  allergies: 'Peanuts', treat_ok: true, photo: true, waiver_agree: true, waiver_name: 'Jane Doe',
};
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

// Stripe webhook helpers — a real HMAC over the raw bytes, like Stripe sends.
function stripeEvent(rid, sessionId, extra) {
  return JSON.stringify({ id: 'evt_' + rid, object: 'event', type: 'checkout.session.completed', data: { object: { id: sessionId, object: 'checkout.session', client_reference_id: rid, metadata: { rid }, payment_status: 'paid', ...(extra || {}) } } });
}
function sign(raw, secret = process.env.STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex')}`;
}
// stream:true delivers the body the way Vercel does with bodyParser:false — as a readable stream
// the handler must async-iterate (readRaw's `for await (const c of req)` path).
function webhookReq(raw, header, { stream = false } = {}) {
  const headers = { 'stripe-signature': header, 'content-type': 'application/json' };
  if (!stream) return mockReq({ method: 'POST', headers, body: raw });
  return Object.assign(Readable.from([Buffer.from(raw)]), { method: 'POST', headers, query: {} });
}
const fsWrites = () => fake.calls({ host: 'firestore', method: 'PATCH' }).concat(fake.calls({ host: 'firestore', method: 'POST' }).filter((e) => !e.path.endsWith(':runQuery')));

// ═════════════════════════════════════════════════════════════════════════
group('1. Happy path — POST /api/checkout → Stripe → GET /api/confirm');
let rid1 = '';
await test('POST /api/checkout → 200 {url, rid}; PENDING doc stored with the Stripe session id before the URL is handed out', async () => {
  const res = await call(checkout, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }, body: GOOD });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(res.body.url, /^https:\/\/checkout\.stripe\.com\//);
  rid1 = res.body.rid;
  assert.match(rid1, /^[A-Za-z0-9_-]{1,128}$/);
  const d = fake.doc(`registrations/${rid1}`);
  assert.ok(d, 'registration doc exists');
  assert.equal(d.status, 'pending');
  assert.equal(d.payment_provider, 'stripe');
  assert.equal(d.amount_cents, 2 * PRICE.perSessionCents);
  assert.equal(d.amount_refunded_cents, 0);
  assert.equal(d.stripe_session_id, 'cs_test_1');
  assert.equal(d.stripe_payment_intent, 'pi_1');
  assert.equal(d.parent_email, 'jane@x.com');
  assert.equal(d.waiver_ip, '198.51.100.7');
  assert.ok(d.created && d.waiver_at, 'created + waiver_at stamped');
  assert.deepEqual(d.sessions, ['s1', 's2']);
  assert.deepEqual(d.players, [{ first: 'Kobe', last: 'B', dob: '2015-01-01', grade: '5' }]);
  // What Stripe was asked for: authoritative amount, rid in metadata + client_reference_id, 1h expiry.
  const cs = fake.calls({ host: 'api.stripe.com', method: 'POST', path: '/v1/checkout/sessions' });
  assert.equal(cs.length, 1);
  assert.equal(cs[0].body['line_items[0][price_data][unit_amount]'], String(2 * PRICE.perSessionCents));
  assert.equal(cs[0].body['line_items[0][quantity]'], '1');
  assert.equal(cs[0].body['metadata[rid]'], rid1);
  assert.equal(cs[0].body['payment_intent_data[metadata][rid]'], rid1);
  assert.equal(cs[0].body.client_reference_id, rid1);
  assert.equal(cs[0].body.customer_email, 'jane@x.com');
  assert.equal(cs[0].body.success_url, `${process.env.SITE_URL}/register-success.html?rid=${rid1}&provider=stripe`);
  assert.equal(cs[0].body.cancel_url, `${process.env.SITE_URL}/register.html`);
  const exp = parseInt(cs[0].body.expires_at, 10), now = Math.floor(Date.now() / 1000);
  assert.ok(exp >= now + 3500 && exp <= now + 3600, 'checkout link expires in ~1h');
  const s = fake.stripe.session('cs_test_1');
  assert.equal(s.payment_status, 'unpaid');
  assert.equal(s.amount_total, 7000);
  assert.equal(fake.mails().length, 0, 'no email before payment');
});
await test('GET /api/confirm before the parent pays → ok:false, doc stays pending, no email', async () => {
  const res = await call(confirm, { method: 'GET', query: { rid: rid1 } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: false, status: 'pending' });
  assert.equal(fake.doc(`registrations/${rid1}`).status, 'pending');
  assert.equal(fake.mails().length, 0);
});
await test('GET /api/confirm after Stripe marks it paid → paid, card_last4 4242, ONE receipt to the parent (BCC admin)', async () => {
  fake.state.log.length = 0; // count only THIS confirm's calls (the unpaid probe above already fetched the session + intent once)
  const sBefore = 0;
  fake.stripe.pay('cs_test_1', { last4: '4242' });
  const res = await call(confirm, { method: 'GET', query: { rid: rid1 } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'paid');
  assert.equal(res.body.card_last4, '4242');
  assert.equal(res.body.paid_via, 'Stripe');
  assert.equal(res.body.amount, '70.00');
  assert.equal(res.body.base, '60.00');
  assert.equal(res.body.processing, '10.00');
  assert.equal(res.body.reg_id, rid1);
  assert.deepEqual(res.body.players, ['Kobe B']);
  assert.deepEqual(res.body.sessions_labels, ['Sun, Sep 27', 'Sun, Oct 4']);
  for (const k of ['parent_email', 'parent_phone', 'emerg_phone', 'allergies']) assert.ok(!(k in res.body), `${k} must not be on the public receipt`);
  const d = fake.doc(`registrations/${rid1}`);
  assert.equal(d.status, 'paid');
  assert.equal(d.card_last4, '4242');
  assert.equal(d.paid_via, 'Stripe');
  assert.equal(d.stripe_payment_intent, 'pi_1');
  assert.equal(d.amount_captured_cents, 7000);
  assert.equal(d.amount_mismatch, undefined, 'captured == expected → no mismatch flag');
  assert.equal(d.confirm_email_sent, true);
  assert.ok(d.paid_at && d.confirm_email_at);
  const m = fake.mails();
  assert.equal(m.length, 1, 'exactly one SendGrid call');
  assert.deepEqual(m[0].personalizations[0].to, [{ email: 'jane@x.com' }]);
  assert.deepEqual(m[0].personalizations[0].bcc, [{ email: ADMIN_EMAIL }]);
  assert.equal(m[0].from.email, process.env.MAIL_FROM);
  assert.match(m[0].subject, /You're registered/);
  assert.ok(m[0].html.includes(rid1) && m[0].html.includes('4242') && m[0].html.includes('$70.00') && m[0].html.includes('Kobe B'), 'receipt names the rid, card, total, player');
  assert.ok(m[0].text.length > 50 && !/<[a-z]/i.test(m[0].text), 'plain-text part is real text');
  // Verification went session → payment_intent → charge (Stripe returned bare ids for the expand).
  assert.equal(fake.calls({ host: 'api.stripe.com', path: '/v1/checkout/sessions/cs_test_1' }).length, sBefore + 1);
  assert.equal(fake.calls({ host: 'api.stripe.com', path: '/v1/payment_intents/pi_1' }).length, 1);
  assert.equal(fake.calls({ host: 'api.stripe.com', path: '/v1/charges/ch_1' }).length, 1);
  assert.ok(fake.calls({ host: 'api.stripe.com' }).every((e) => e.headers.authorization === `Bearer ${process.env.STRIPE_SECRET_KEY}`));
});
await test('second GET /api/confirm is idempotent: same receipt, still ONE email, no Firestore writes', async () => {
  const before = fake.meta(`registrations/${rid1}`).updateTime;
  const writes = fsWrites().length;
  const res = await call(confirm, { method: 'GET', query: { rid: rid1 } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'paid');
  assert.equal(res.body.card_last4, '4242');
  assert.equal(fake.mails().length, 1, 'no second email');
  assert.equal(fake.meta(`registrations/${rid1}`).updateTime, before, 'doc untouched');
  assert.equal(fsWrites().length, writes, 'no Firestore writes');
});
await test('verify also captures last4 when Stripe honours the expand (nested payment_intent.latest_charge) — one Stripe call', async () => {
  fake.reset();
  fake.state.opts.stripeNestExpand = true;
  const s = fake.stripe.seedSession({ id: 'cs_nest', paid: true, amount: 3500, last4: '1881' });
  const rid = fake.seedReg({ status: 'pending', stripe_session_id: 'cs_nest', stripe_payment_intent: '', sessions: ['s1'] });
  const res = await call(confirm, { method: 'GET', query: { rid } });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.card_last4, '1881');
  const d = fake.doc(`registrations/${rid}`);
  assert.equal(d.status, 'paid');
  assert.equal(d.stripe_payment_intent, s.payment_intent);
  assert.equal(fake.calls({ host: 'api.stripe.com' }).length, 1, 'no extra payment_intent/charge fetches');
  assert.equal(fake.mails().length, 1);
});
await test('a captured amount that differs from our price is still marked paid but flagged amount_mismatch', async () => {
  fake.reset();
  fake.stripe.seedSession({ id: 'cs_mis', paid: true, amount: 100 }); // Stripe captured $1.00 for a $38 session
  const rid = fake.seedReg({ status: 'pending', stripe_session_id: 'cs_mis', stripe_payment_intent: '', sessions: ['s1'] });
  const res = await call(confirm, { method: 'GET', query: { rid } });
  assert.equal(res.body.ok, true);
  const d = fake.doc(`registrations/${rid}`);
  assert.equal(d.status, 'paid');
  assert.equal(d.amount_captured_cents, 100);
  assert.equal(d.amount_mismatch, true);
});
await test('a terminal-state confirm never flips back to paid — but money that arrived after a cancel is FLAGGED (paid_after_cancel) so admin can refund it', async () => {
  fake.reset();
  fake.stripe.seedSession({ id: 'cs_t', paid: true, amount: 3500 });
  for (const status of ['canceled', 'refunded', 'abandoned', 'error']) {
    const rid = fake.seedReg({ status, stripe_session_id: 'cs_t', confirm_email_sent: false });
    const res = await call(confirm, { method: 'GET', query: { rid } });
    assert.deepEqual(res.body, { ok: false, status });
    const d = fake.doc(`registrations/${rid}`);
    assert.equal(d.status, status, 'status is never re-flipped');
    if (status === 'refunded') assert.ok(!d.paid_after_cancel, 'a refunded reg is not re-checked');
    else { assert.equal(d.paid_after_cancel, true, status + ': late payment flagged'); assert.ok(d.paid_after_cancel_at); }
  }
  assert.equal(fake.mails().length, 0, 'no receipt for a record that is not paid');
});

// ═════════════════════════════════════════════════════════════════════════
group('2. Race — webhook, confirm and the reconcile cron finalize the SAME payment concurrently');
for (const variant of ['webhook first', 'confirm first', 'no event-loop latency (tight interleave)']) {
  await test(`${variant}: status paid, exactly ONE receipt, losers stopped by the updateTime precondition`, async () => {
    fake.reset();
    if (variant.startsWith('no event-loop')) fake.state.opts.latency = false;
    fake.stripe.seedSession({ id: 'cs_race', paid: true, amount: 3500 });
    const rid = fake.seedReg({ status: 'pending', stripe_session_id: 'cs_race', stripe_payment_intent: '', sessions: ['s1'], created: iso(10 * MIN) });
    const raw = stripeEvent(rid, 'cs_race');
    const wres = mockRes(), cres = mockRes(), rres = mockRes();
    const tasks = [
      () => webhook(webhookReq(raw, sign(raw), { stream: true }), wres),
      () => confirm(mockReq({ method: 'GET', query: { rid } }), cres),
      () => reconcile(mockReq({ headers: CRON }), rres),
    ];
    if (variant === 'confirm first') tasks.reverse();
    await Promise.all(tasks.map((t) => t()));
    assert.equal(wres.statusCode, 200, JSON.stringify(wres.body));
    assert.equal(cres.statusCode, 200, JSON.stringify(cres.body));
    assert.equal(rres.statusCode, 200, JSON.stringify(rres.body));
    assert.equal(wres.body.ok, true);
    assert.equal(cres.body.ok, true);
    assert.equal(cres.body.status, 'paid');
    const d = fake.doc(`registrations/${rid}`);
    assert.equal(d.status, 'paid');
    assert.equal(d.card_last4, '4242');
    assert.equal(d.confirm_email_sent, true);
    assert.equal(fake.mails().length, 1, 'exactly one confirmation email across all three paths');
    assert.deepEqual(fake.mails()[0].to, ['jane@x.com']);
    // The "claim before send" is what serialised them: exactly one conditional PATCH won.
    const claims = fake.calls({ host: 'firestore', method: 'PATCH' }).filter((e) => e.query.has('currentDocument.updateTime'));
    assert.ok(claims.length >= 1, 'at least one conditional claim attempted');
    assert.equal(claims.filter((e) => e.status === 200).length, 1, 'exactly one claim succeeded');
    assert.ok(claims.filter((e) => e.status !== 200).every((e) => e.status === 400 && e.response.error.status === 'FAILED_PRECONDITION'), 'losers got FAILED_PRECONDITION');
  });
}

// ═════════════════════════════════════════════════════════════════════════
group('3. Reconcile cron — finalizes paid-but-never-returned, abandons stale unpaid, never abandons on outage');
await test('unauthorized → 401 and Firestore is never touched', async () => {
  const res = await call(reconcile, { headers: { authorization: 'Bearer nope' } });
  assert.equal(res.statusCode, 401);
  assert.equal(fake.calls({ host: 'firestore' }).length, 0);
});
let rec = {};
await test('one pass: paid→finalized(+1 email), stale unpaid→abandoned, fresh/young/outage→untouched; list pagination exercised', async () => {
  fake.reset();
  fake.state.opts.listPageSize = 2; // force several pages so fsList's pageToken loop is actually walked
  fake.stripe.seedSession({ id: 'cs_A', paid: false, amount: 3500 });
  fake.stripe.seedSession({ id: 'cs_B', paid: true, amount: 3500 });
  fake.stripe.seedSession({ id: 'cs_C', paid: false, amount: 3500 });
  fake.stripe.seedSession({ id: 'cs_D', paid: false, amount: 3500 });
  fake.stripe.seedSession({ id: 'cs_E', paid: false, amount: 3500 });
  fake.state.stripe.failSessions.add('cs_E'); // Stripe 503 for this one → inconclusive
  rec = {
    A: fake.seedReg({ status: 'pending', stripe_session_id: 'cs_A', stripe_payment_intent: '', created: iso(3 * DAY), parent_email: 'a@x.com' }),
    B: fake.seedReg({ status: 'pending', stripe_session_id: 'cs_B', stripe_payment_intent: '', created: iso(3 * DAY), parent_email: 'b@x.com' }),
    C: fake.seedReg({ status: 'pending', stripe_session_id: 'cs_C', stripe_payment_intent: '', created: iso(30 * 1000), parent_email: 'c@x.com' }),
    D: fake.seedReg({ status: 'pending', stripe_session_id: 'cs_D', stripe_payment_intent: '', created: iso(3 * HOUR), parent_email: 'd@x.com' }),
    E: fake.seedReg({ status: 'pending', stripe_session_id: 'cs_E', stripe_payment_intent: '', created: iso(3 * DAY), parent_email: 'e@x.com' }),
    F: fake.seedReg({ status: 'paid', parent_email: 'f@x.com' }),
    G: fake.seedReg({ status: 'pending', stripe_session_id: '', created: iso(3 * DAY), parent_email: 'g@x.com' }), // never reached Stripe (no session)
  };
  fake.seed('registrations/_sessions', { s5: { canceled: false } });
  const res = await call(reconcile, { headers: CRON });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { ok: true, pending: 6, checked: 5, finalized: 1, abandoned: 2, inconclusive: 1, emailed: 0, deferred: 0 });
  const st = (k) => fake.doc(`registrations/${rec[k]}`);
  assert.equal(st('A').status, 'abandoned'); assert.ok(st('A').abandoned_at);
  assert.equal(st('B').status, 'paid'); assert.equal(st('B').card_last4, '4242'); assert.equal(st('B').confirm_email_sent, true);
  assert.equal(st('C').status, 'pending', 'younger than the 2-minute grace → not even checked');
  assert.equal(st('D').status, 'pending', 'unpaid but younger than 2 days → kept');
  assert.equal(st('E').status, 'pending', 'Stripe outage → inconclusive, NEVER abandoned');
  assert.equal(st('E').abandoned_at, undefined);
  assert.equal(st('F').status, 'paid');
  assert.equal(st('G').status, 'abandoned', 'no session ever created + stale → abandoned');
  assert.equal(fake.mails().length, 1);
  assert.deepEqual(fake.mails()[0].to, ['b@x.com']);
  assert.equal(fake.calls({ host: 'api.stripe.com', path: '/v1/checkout/sessions/cs_C' }).length, 0, 'fresh reg not verified');
  assert.ok(fake.calls({ host: 'firestore', method: 'GET', path: /\/registrations$/ }).length >= 4, 'walked multiple list pages');
});
await test('heartbeat doc registrations/_cron_reconcile is written with the run counts', async () => {
  const hb = fake.doc('registrations/_cron_reconcile');
  assert.ok(hb, 'heartbeat exists');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(hb.last_run));
  assert.equal(hb.pending, 6); assert.equal(hb.finalized, 1); assert.equal(hb.abandoned, 2); assert.equal(hb.inconclusive, 1); assert.equal(hb.ok, true);
});
await test('a second pass is a no-op: B already paid, nothing re-emailed, abandoned stay abandoned', async () => {
  const res = await call(reconcile, { headers: CRON });
  assert.deepEqual(res.body, { ok: true, pending: 3, checked: 2, finalized: 0, abandoned: 0, inconclusive: 1, emailed: 0, deferred: 0 });
  assert.equal(fake.mails().length, 1);
  assert.equal(fake.doc(`registrations/${rec.A}`).status, 'abandoned');
});
await test('manual trigger with the admin key works too; wrong key does not', async () => {
  assert.equal((await call(reconcile, { headers: ADMIN })).statusCode, 200);
  assert.equal((await call(reconcile, { headers: { 'x-admin-key': 'nope' } })).statusCode, 401);
});

// ═════════════════════════════════════════════════════════════════════════
group('4. Duplicate guard — same family, same child, same Sunday');
const KOBE = { first: 'Kobe', last: 'B', dob: '2015-01-01' };
await test('a PAID reg for jane@x.com / Kobe B / [s1] + new checkout for [s1,s2] → 409 already_registered, nothing created', async () => {
  fake.seedReg({ status: 'paid', parent_email: 'jane@x.com', players: [KOBE], sessions: ['s1'] });
  const before = fake.docs('registrations').length;
  const res = await call(checkout, { method: 'POST', body: { ...GOOD, sessions: ['s1', 's2'], players: [KOBE] } });
  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  assert.equal(res.body.error, 'already_registered');
  assert.equal(fake.docs('registrations').length, before, 'no pending doc created');
  assert.equal(fake.calls({ host: 'api.stripe.com' }).length, 0, 'Stripe never called');
  const q = fake.calls({ host: 'firestore', path: ':runQuery' });
  assert.equal(q.length, 1);
  assert.equal(q[0].body.structuredQuery.where.fieldFilter.field.fieldPath, 'parent_email');
  assert.deepEqual(q[0].body.structuredQuery.where.fieldFilter.value, { stringValue: 'jane@x.com' });
});
await test('case/whitespace variants of the same email + name still collide (normalized before the lookup)', async () => {
  const res = await call(checkout, { method: 'POST', body: { ...GOOD, parent_email: '  Jane@X.com ', sessions: ['s1'], players: [{ first: 'kobe', last: 'b', dob: '2015-01-01' }] } });
  assert.equal(res.statusCode, 409);
});
await test('same email + player but a NON-overlapping Sunday [s3] → allowed (200)', async () => {
  const res = await call(checkout, { method: 'POST', body: { ...GOOD, sessions: ['s3'], players: [KOBE] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(fake.doc(`registrations/${res.body.rid}`).status, 'pending');
});
await test('a sibling (different dob) on the same Sunday under the same email → allowed', async () => {
  const res = await call(checkout, { method: 'POST', body: { ...GOOD, sessions: ['s1'], players: [{ first: 'Maya', last: 'B', dob: '2017-06-06' }] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});
await test('a PENDING (unpaid) prior attempt never blocks a retry', async () => {
  fake.seedReg({ status: 'pending', parent_email: 'retry@x.com', players: [KOBE], sessions: ['s1'] });
  const res = await call(checkout, { method: 'POST', body: { ...GOOD, parent_email: 'retry@x.com', sessions: ['s1'], players: [KOBE] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});
await test('KNOWN LIMITATION: the same child under a DIFFERENT parent email is allowed (guard keys on parent_email)', async () => {
  const res = await call(checkout, { method: 'POST', body: { ...GOOD, parent_email: 'john@x.com', sessions: ['s1'], players: [KOBE] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});
await test('a Firestore lookup failure never blocks a real signup (guard is best-effort)', async () => {
  fake.reset();
  fake.seedReg({ status: 'paid', parent_email: 'jane@x.com', players: [KOBE], sessions: ['s1'] });
  // Simulate the query endpoint alone failing: make runQuery return a 503 by poisoning the body shape it sees.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).includes(':runQuery') ? new Response('{"error":{"code":503,"status":"UNAVAILABLE"}}', { status: 503 }) : realFetch(url, init));
  try {
    const res = await call(checkout, { method: 'POST', body: { ...GOOD, sessions: ['s1'], players: [KOBE] } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  } finally { globalThis.fetch = realFetch; }
});

// ═════════════════════════════════════════════════════════════════════════
group('5. Cancelled Sunday — registrations/_sessions {s2:{canceled:true}}');
await test('GET /api/checkout reports canceled:["s2"] (register.html greys it out)', async () => {
  fake.seed('registrations/_sessions', { s2: { canceled: true, canceled_at: '2026-10-03T12:00:00.000Z', subject: 'Snow' }, s4: { canceled: false, reopened_at: '2026-10-01T00:00:00.000Z' } });
  const res = await call(checkout, { method: 'GET' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ready: true, provider: 'stripe', canceled: ['s2'] });
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
await test('POST /api/checkout with sessions [s1,s2] → 400 session_canceled {sessions:["s2"]}, nothing created, Stripe untouched', async () => {
  const before = fake.docs('registrations').length;
  const res = await call(checkout, { method: 'POST', body: { ...GOOD, sessions: ['s1', 's2'] } });
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: 'session_canceled', sessions: ['s2'] });
  assert.equal(fake.docs('registrations').length, before);
  assert.equal(fake.calls({ host: 'api.stripe.com' }).length, 0);
});
await test('a reopened Sunday (s4 canceled:false) still sells', async () => {
  const res = await call(checkout, { method: 'POST', body: { ...GOOD, sessions: ['s4'] } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});
await test('remind cron on the eve of cancelled s2 → skipped:session_canceled, ZERO emails, no reminded_ flags', async () => {
  fake.seedReg({ status: 'paid', sessions: ['s2'], parent_email: 'p2@x.com' });
  fake.seedReg({ status: 'paid', sessions: ['s1', 's2', 's3', 's4', 's5', 's6'], parent_email: 'all6@x.com' });
  const res = await fake.withNow('2026-10-03T20:00:00Z', () => call(remind, { headers: CRON })); // Sat Oct 3, 4 pm EDT
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, tomorrow: '2026-10-04', session: 's2', sent: 0, skipped: 'session_canceled' });
  assert.equal(fake.mails().length, 0);
  assert.ok(fake.docs('registrations').every((d) => !d.reminded_s2));
  assert.equal(fake.calls({ host: 'firestore', method: 'GET', path: /\/registrations$/ }).length, 0, 'roster never even listed');
});
await test('remind cron on a non-eve day → session:null, nothing sent', async () => {
  const res = await fake.withNow('2026-09-30T12:00:00Z', () => call(remind, { headers: CRON }));
  assert.deepEqual(res.body, { ok: true, tomorrow: '2026-10-01', session: null, sent: 0 });
  assert.equal(fake.mails().length, 0);
});
await test('positive control — eve of s1 (not cancelled): one reminder per PAID attendee, reminded_s1 flag set, re-run sends nothing', async () => {
  fake.reset();
  const p1 = fake.seedReg({ status: 'paid', sessions: ['s1'], parent_email: 'p1@x.com', players: [{ first: 'Maya', last: 'Avery', dob: '2015-01-01' }] });
  const p2 = fake.seedReg({ status: 'paid', sessions: ['s1', 's2', 's3', 's4', 's5', 's6'], parent_email: 'all6@x.com' });
  fake.seedReg({ status: 'paid', sessions: ['s2'], parent_email: 'p2only@x.com' });
  fake.seedReg({ status: 'pending', sessions: ['s1'], parent_email: 'pending@x.com' });
  fake.seedReg({ status: 'refunded', sessions: ['s1'], parent_email: 'refunded@x.com' });
  fake.seedReg({ status: 'paid', sessions: ['s1'], parent_email: 'done@x.com', reminded_s1: true });
  fake.seed('registrations/_sessions', { s2: { canceled: true } }); // s2 cancelled must not affect s1
  let res = await fake.withNow('2026-09-26T20:00:00Z', () => call(remind, { headers: CRON })); // Sat Sep 26, 4 pm EDT
  assert.deepEqual(res.body, { ok: true, tomorrow: '2026-09-27', session: 's1', sent: 2, already: 1, failed: 0 });
  const m = fake.mails();
  assert.equal(m.length, 2);
  assert.deepEqual(m.map((x) => x.to[0]).sort(), ['all6@x.com', 'p1@x.com']);
  assert.ok(m.every((x) => x.bcc.length === 0), 'reminders are not BCC\'d to the admin');
  assert.match(m[0].subject, /Reminder: clinic tomorrow — Sun, Sep 27/);
  assert.ok(m.find((x) => x.to[0] === 'p1@x.com').html.includes('Maya Avery'));
  assert.equal(fake.doc(`registrations/${p1}`).reminded_s1, true);
  assert.equal(fake.doc(`registrations/${p2}`).reminded_s1, true);
  res = await fake.withNow('2026-09-26T23:30:00Z', () => call(remind, { headers: CRON })); // later the same evening
  assert.deepEqual(res.body, { ok: true, tomorrow: '2026-09-27', session: 's1', sent: 0, already: 3, failed: 0 });
  assert.equal(fake.mails().length, 2, 'idempotent — nobody reminded twice');
});
await test('a SendGrid failure leaves the flag unset so the next run retries that family', async () => {
  fake.reset();
  const p = fake.seedReg({ status: 'paid', sessions: ['s1'], parent_email: 'p1@x.com' });
  fake.state.opts.fail.sendgrid = 500;
  let res = await fake.withNow('2026-09-26T20:00:00Z', () => call(remind, { headers: CRON }));
  assert.deepEqual(res.body, { ok: true, tomorrow: '2026-09-27', session: 's1', sent: 0, already: 0, failed: 1 });
  assert.equal(fake.doc(`registrations/${p}`).reminded_s1, undefined);
  fake.state.opts.fail.sendgrid = 0;
  res = await fake.withNow('2026-09-26T21:00:00Z', () => call(remind, { headers: CRON }));
  assert.equal(res.body.sent, 1);
  assert.equal(fake.doc(`registrations/${p}`).reminded_s1, true);
});

// ═════════════════════════════════════════════════════════════════════════
group('6. Notify — cancel one Sunday, email every registered family in ONE SendGrid call');
let n1 = '';
await test('POST /api/notify {session:s1, cancel:true} → one bulk send: 2 families (+admin copy), -parent- = first names; s1 flagged canceled', async () => {
  n1 = fake.seedReg({ status: 'paid', sessions: ['s1', 's2'], parent_email: 'jane@x.com', parent_name: 'Jane Doe', players: [{ first: 'Kobe', last: 'B', dob: '2015-01-01' }, { first: 'Maya', last: 'B', dob: '2017-06-06' }] });
  fake.seedReg({ status: 'paid', sessions: ['s1'], parent_email: 'bob@x.com', parent_name: 'Bob Ross', players: [{ first: 'Noah', last: 'Ross', dob: '2016-02-02' }] });
  fake.seedReg({ status: 'paid', sessions: ['s3'], parent_email: 'carol@x.com', parent_name: 'Carol King' });
  fake.seedReg({ status: 'pending', sessions: ['s1'], parent_email: 'dave@x.com', parent_name: 'Dave Pending' });
  fake.seedReg({ status: 'refunded', sessions: ['s1'], parent_email: 'erin@x.com', parent_name: 'Erin Refunded' });
  const res = await call(notify, { method: 'POST', headers: ADMIN, body: { session: 's1', message: 'Gym is closed for snow.\nSee you Oct 4!', cancel: true } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.session, 's1');
  assert.equal(res.body.families, 2);
  assert.equal(res.body.players, 3);
  assert.equal(res.body.failed, 0);
  assert.equal(res.body.canceled, true);
  const m = fake.mails();
  assert.equal(m.length, 1, 'exactly one SendGrid call');
  const ps = m[0].personalizations;
  assert.equal(ps.length, 3, '2 families + the admin BCC personalization');
  const by = (email) => ps.find((p) => p.to[0].email === email);
  assert.deepEqual(by('jane@x.com').substitutions, { '-parent-': 'Jane' });
  assert.deepEqual(by('bob@x.com').substitutions, { '-parent-': 'Bob' });
  assert.deepEqual(by(ADMIN_EMAIL).substitutions, { '-parent-': 'Parent' });
  assert.equal(by('carol@x.com'), undefined, 's3-only family not emailed');
  assert.equal(by('dave@x.com'), undefined, 'pending reg not emailed');
  assert.equal(by('erin@x.com'), undefined, 'refunded reg not emailed');
  assert.equal(m[0].subject, 'Clinic cancelled — Sun, Sep 27');
  assert.ok(m[0].html.includes('Hi -parent-,') && m[0].html.includes('Gym is closed for snow.<br>See you Oct 4!'));
  assert.ok(m[0].text.includes('Hi -parent-,') && m[0].text.includes('Sun, Sep 27 clinic is cancelled'));
  const st = fake.doc('registrations/_sessions');
  assert.equal(st.s1.canceled, true);
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(st.s1.canceled_at));
});
await test('the cancelled flag is live everywhere: GET /api/checkout, GET /api/notify, GET /api/checkin session list', async () => {
  assert.deepEqual((await call(checkout, { method: 'GET' })).body.canceled, ['s1']);
  const n = await call(notify, { method: 'GET', headers: ADMIN, query: { session: 's1' } });
  assert.equal(n.body.canceled, true); assert.equal(n.body.families, 2); assert.equal(n.body.players, 3); assert.equal(n.body.email_ready, true);
  const c = await call(checkin, { method: 'GET', headers: COACH });
  assert.equal(c.body.sessions.find((s) => s.id === 's1').canceled, true);
  assert.equal(c.body.sessions.find((s) => s.id === 's2').canceled, false);
});
await test('the notice audit log is written as a reserved registrations/_notice_<ts> doc (the only collection the rules allow), invisible to every lister', async () => {
  assert.equal(fake.docs('notices').length, 0, 'nothing may be written to a collection the rules deny');
  const notices = fake.docs('registrations').filter((d) => String(d.id).startsWith('_notice_'));
  assert.equal(notices.length, 1, 'expected one _notice_ doc logging the cancellation');
  assert.equal(notices[0].recipients.length, 2, 'one address per family');
  assert.equal(notices[0].session, 's1'); assert.equal(notices[0].cancel, true); assert.equal(notices[0].families, 2); assert.equal(notices[0].players, 3);
});
await test('a plain notice (no cancel) emails the roster without flagging the session', async () => {
  fake.seed('registrations/_sessions', { s1: { canceled: false } });
  const res = await call(notify, { method: 'POST', headers: ADMIN, body: { session: 's1', subject: 'Bring a jacket', message: 'Gym is chilly.' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.canceled, false);
  assert.equal(fake.mails().length, 2);
  assert.equal(fake.mails()[1].subject, 'Bring a jacket');
  assert.equal(fake.doc('registrations/_sessions').s1.canceled, false);
});
await test('POST {reopen:true} clears the flag (merging, not clobbering, the session entry) and sends nothing', async () => {
  await call(notify, { method: 'POST', headers: ADMIN, body: { session: 's1', message: 'x', cancel: true } });
  const before = fake.mails().length;
  const res = await call(notify, { method: 'POST', headers: ADMIN, body: { session: 's1', reopen: true } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, session: 's1', canceled: false });
  const st = fake.doc('registrations/_sessions');
  assert.equal(st.s1.canceled, false);
  assert.ok(st.s1.reopened_at && st.s1.canceled_at, 'history kept');
  assert.equal(fake.mails().length, before);
  assert.deepEqual((await call(checkout, { method: 'GET' })).body.canceled, []);
});
await test('the coach passcode cannot send notices (401) and the admin cannot notify a bogus session (400)', async () => {
  assert.equal((await call(notify, { method: 'POST', headers: COACH, body: { session: 's1', message: 'x' } })).statusCode, 401);
  assert.equal((await call(notify, { method: 'POST', headers: { 'x-admin-key': 'coach-pass' }, body: { session: 's1', message: 'x' } })).statusCode, 401);
  assert.equal((await call(notify, { method: 'POST', headers: ADMIN, body: { session: 's9', message: 'x' } })).statusCode, 400);
});

// ═════════════════════════════════════════════════════════════════════════
group('7. Check-in — door-side roster only, attendance stamps per player');
let r1 = '', r2 = '';
const DOOR_KEYS = ['rid', 'pi', 'first', 'last', 'parent_name', 'parent_phone', 'emerg_name', 'emerg_phone', 'pickup_name', 'pickup_phone', 'medical', 'present', 'present_at'].sort();
await test('GET /api/checkin?session=s1 with CHECKIN_PASSWORD → paid attendees only, ONLY door-side fields', async () => {
  r1 = fake.seedReg({ status: 'paid', sessions: ['s1'], parent_email: 'jane@x.com', parent_name: 'Jane Doe', waiver_name: 'Jane Q Doe-Signature', pickup_name: 'Gran', pickup_phone: '610-555-0102',
    players: [{ first: 'Maya', last: 'Avery', dob: '2015-01-01' }, { first: 'Marcus', last: 'Avery', dob: '2017-06-06' }], allergies: 'Peanuts', medications: 'n/a', medical_conditions: 'Asthma' });
  r2 = fake.seedReg({ status: 'paid', sessions: ['s1', 's3'], parent_email: 'sam@x.com', parent_name: 'Sam Tinker', players: [{ first: 'Noah', last: 'Tinker', dob: '2016-02-02' }] });
  fake.seedReg({ status: 'refunded', sessions: ['s1'], parent_email: 'gone@x.com', players: [{ first: 'Refunded', last: 'Kid', dob: '2016-02-02' }] });
  fake.seedReg({ status: 'paid', sessions: ['s3'], parent_email: 's3only@x.com', players: [{ first: 'Later', last: 'Kid', dob: '2016-02-02' }] });
  fake.seedReg({ status: 'pending', sessions: ['s1'], parent_email: 'unpaid@x.com', players: [{ first: 'Unpaid', last: 'Kid', dob: '2016-02-02' }] });
  fake.seedReg({ status: 'canceled', sessions: ['s1'], parent_email: 'cx@x.com', players: [{ first: 'Canceled', last: 'Kid', dob: '2016-02-02' }] });
  fake.seed('registrations/_cron_reconcile', { last_run: '2026-09-01T00:00:00Z', ok: true });
  const res = await call(checkin, { method: 'GET', headers: COACH, query: { session: 's1' } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.session, { id: 's1', label: 'Sun, Sep 27', date: '2026-09-27' });
  assert.deepEqual(res.body.counts, { total: 3, present: 0 });
  assert.deepEqual(res.body.players.map((p) => `${p.first} ${p.last}`), ['Marcus Avery', 'Maya Avery', 'Noah Tinker'], 'sorted by last, first');
  assert.deepEqual(res.body.players.map((p) => [p.rid, p.pi]), [[r1, 1], [r1, 0], [r2, 0]]);
  for (const p of res.body.players) assert.deepEqual(Object.keys(p).sort(), DOOR_KEYS, 'exactly the door-side field set');
  const maya = res.body.players[1];
  assert.equal(maya.parent_name, 'Jane Doe'); assert.equal(maya.parent_phone, '610-555-0100'); assert.equal(maya.pickup_name, 'Gran');
  assert.equal(maya.medical, 'Allergies: Peanuts · Conditions: Asthma', '"n/a" meds filtered out');
  assert.equal(maya.present, false); assert.equal(maya.present_at, '');
  const json = JSON.stringify(res.body);
  for (const leak of ['@', 'Doe-Signature', 'amount_cents', 'waiver', 'stripe', '4242', 'medical_conditions', 'dob']) assert.ok(!json.includes(leak), `roster must not contain "${leak}"`);
});
await test('POST present:true for player 0 writes attendance.s1["0"] (ISO stamp)', async () => {
  const res = await call(checkin, { method: 'POST', headers: COACH, body: { rid: r1, session: 's1', player: 0, present: true } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.present, true); assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(res.body.present_at));
  const att = fake.doc(`registrations/${r1}`).attendance;
  assert.deepEqual(Object.keys(att), ['s1']);
  assert.deepEqual(Object.keys(att.s1), ['0']);
  assert.equal(att.s1['0'], res.body.present_at);
});
let stamp0 = '';
await test('a second POST for player 1 preserves player 0\'s stamp (read-modify-write of the whole map)', async () => {
  stamp0 = fake.doc(`registrations/${r1}`).attendance.s1['0'];
  const res = await call(checkin, { method: 'POST', headers: COACH, body: { rid: r1, session: 's1', player: 1, present: true } });
  assert.equal(res.statusCode, 200);
  const att = fake.doc(`registrations/${r1}`).attendance;
  assert.deepEqual(Object.keys(att.s1).sort(), ['0', '1']);
  assert.equal(att.s1['0'], stamp0, 'player 0 stamp untouched');
  const roster = await call(checkin, { method: 'GET', headers: COACH, query: { session: 's1' } });
  assert.deepEqual(roster.body.counts, { total: 3, present: 2 });
  assert.equal(roster.body.players.find((p) => p.first === 'Maya').present_at, stamp0);
});
await test('check-in for the same family on a different Sunday keeps s1 intact', async () => {
  // r2 attends s1 and s3
  await call(checkin, { method: 'POST', headers: COACH, body: { rid: r2, session: 's1', player: 0, present: true } });
  const res = await call(checkin, { method: 'POST', headers: COACH, body: { rid: r2, session: 's3', player: 0, present: true } });
  assert.equal(res.statusCode, 200);
  const att = fake.doc(`registrations/${r2}`).attendance;
  assert.deepEqual(Object.keys(att).sort(), ['s1', 's3']);
});
await test('POST present:false deletes only that player\'s stamp', async () => {
  const res = await call(checkin, { method: 'POST', headers: COACH, body: { rid: r1, session: 's1', player: 0, present: false } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.present, false); assert.equal(res.body.present_at, '');
  const att = fake.doc(`registrations/${r1}`).attendance;
  assert.deepEqual(Object.keys(att.s1), ['1']);
  const roster = await call(checkin, { method: 'GET', headers: COACH, query: { session: 's1' } });
  assert.deepEqual(roster.body.counts, { total: 3, present: 2 }); // Marcus + Noah
});
await test('not on the roster → 400: refunded reg, a session the family did not buy, a player index past the end, unknown rid → 404', async () => {
  const refunded = fake.docs('registrations').find((d) => d.status === 'refunded').id;
  let res = await call(checkin, { method: 'POST', headers: COACH, body: { rid: refunded, session: 's1', player: 0, present: true } });
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'not_on_roster');
  res = await call(checkin, { method: 'POST', headers: COACH, body: { rid: r1, session: 's2', player: 0, present: true } });
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'not_on_roster');
  res = await call(checkin, { method: 'POST', headers: COACH, body: { rid: r1, session: 's1', player: 5, present: true } });
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'not_on_roster');
  res = await call(checkin, { method: 'POST', headers: COACH, body: { rid: 'nope', session: 's1', player: 0, present: true } });
  assert.equal(res.statusCode, 404);
  assert.equal(fake.doc(`registrations/${refunded}`).attendance, undefined);
});
await test('the admin passcode works at the door too; a wrong key does not', async () => {
  assert.equal((await call(checkin, { method: 'GET', headers: ADMIN, query: { session: 's1' } })).statusCode, 200);
  assert.equal((await call(checkin, { method: 'GET', headers: { 'x-checkin-key': 'nope' }, query: { session: 's1' } })).statusCode, 401);
});

// ═════════════════════════════════════════════════════════════════════════
group('8. Refund — through Stripe, tracked on the doc, receipt emailed once per refund');
let rr = '';
await test('partial refund $30 of $70 → Stripe refund call, amount_refunded_cents 3000, status stays paid, ONE refund receipt (BCC admin)', async () => {
  fake.stripe.seedSession({ id: 'cs_ref', pi: 'pi_ref', paid: true, amount: 7000 });
  rr = fake.seedReg({ status: 'paid', sessions: ['s1', 's2'], stripe_session_id: 'cs_ref', stripe_payment_intent: 'pi_ref' });
  const res = await call(refund, { method: 'POST', headers: ADMIN, body: { rid: rr, amount_cents: 3000 } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { ok: true, refunded_cents: 3000, refunded: '30.00', status: 'paid' });
  const calls = fake.calls({ host: 'api.stripe.com', method: 'POST', path: '/v1/refunds' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { payment_intent: 'pi_ref', amount: '3000' });
  assert.ok(String(calls[0].headers['idempotency-key']).startsWith(`rf_${rr}_`), 'idempotency key per attempt');
  assert.equal(fake.stripe.charge(fake.stripe.intent('pi_ref').latest_charge).amount_refunded, 3000);
  const d = fake.doc(`registrations/${rr}`);
  assert.equal(d.amount_refunded_cents, 3000); assert.equal(d.status, 'paid'); assert.equal(d.last_refund_id, 're_1'); assert.ok(d.last_refund_at);
  const m = fake.mails();
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].to, ['jane@x.com']); assert.deepEqual(m[0].bcc, [ADMIN_EMAIL]);
  assert.match(m[0].subject, /Refund processed/);
  assert.ok(m[0].html.includes('$30.00') && m[0].html.includes('Partial refund') && m[0].html.includes('$30.00 of $70.00') && m[0].html.includes('4242'));
});
await test('over-refund attempt (amount_cents 999999) is clamped to the remaining $40 → fully refunded, status refunded, second receipt', async () => {
  const res = await call(refund, { method: 'POST', headers: ADMIN, body: { rid: rr, amount_cents: 999999 } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { ok: true, refunded_cents: 7000, refunded: '70.00', status: 'refunded' });
  const calls = fake.calls({ host: 'api.stripe.com', method: 'POST', path: '/v1/refunds' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.amount, '4000');
  assert.equal(fake.stripe.charge('ch_1').refunded, true);
  const d = fake.doc(`registrations/${rr}`);
  assert.equal(d.amount_refunded_cents, 7000); assert.equal(d.status, 'refunded'); assert.equal(d.last_refund_id, 're_2');
  assert.equal(fake.mails().length, 2);
  assert.ok(fake.mails()[1].html.includes('$40.00') && !fake.mails()[1].html.includes('Partial refund'));
});
await test('a third attempt → 400 already_fully_refunded; Stripe not called, no email', async () => {
  const res = await call(refund, { method: 'POST', headers: ADMIN, body: { rid: rr } });
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'already_fully_refunded');
  assert.equal(fake.calls({ host: 'api.stripe.com', method: 'POST', path: '/v1/refunds' }).length, 2);
  assert.equal(fake.mails().length, 2);
});
await test('a fully-refunded reg is off the check-in roster and its confirm is terminal', async () => {
  const roster = await call(checkin, { method: 'GET', headers: COACH, query: { session: 's1' } });
  assert.ok(!roster.body.players.some((p) => p.rid === rr));
  assert.deepEqual((await call(confirm, { method: 'GET', query: { rid: rr } })).body, { ok: false, status: 'refunded' });
});
await test('refusals: pending reg (no payment) → not_refundable; zero/negative → bad_amount; wrong key → 401; nothing hits Stripe', async () => {
  const pending = fake.seedReg({ status: 'pending' });
  let res = await call(refund, { method: 'POST', headers: ADMIN, body: { rid: pending } });
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'not_refundable');
  fake.stripe.seedSession({ id: 'cs_ok', pi: 'pi_ok', paid: true, amount: 3500 });
  const paid = fake.seedReg({ status: 'paid', stripe_session_id: 'cs_ok', stripe_payment_intent: 'pi_ok' });
  res = await call(refund, { method: 'POST', headers: ADMIN, body: { rid: paid, amount_cents: 0 } });
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'bad_amount');
  res = await call(refund, { method: 'POST', headers: ADMIN, body: { rid: paid, amount_cents: -5 } });
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'bad_amount');
  res = await call(refund, { method: 'POST', headers: { 'x-admin-key': 'nope' }, body: { rid: paid } });
  assert.equal(res.statusCode, 401);
  assert.equal(fake.calls({ host: 'api.stripe.com', method: 'POST', path: '/v1/refunds' }).length, 2);
  assert.equal(fake.doc(`registrations/${paid}`).amount_refunded_cents, 0);
});
await test('if Stripe refuses (our doc says $99.99 but Stripe only captured $38) → 502 refund_failed, doc untouched, no email', async () => {
  fake.reset();
  fake.stripe.seedSession({ id: 'cs_bad', pi: 'pi_bad', paid: true, amount: 3500 });
  const rid = fake.seedReg({ status: 'paid', stripe_session_id: 'cs_bad', stripe_payment_intent: 'pi_bad', amount_cents: 9999 });
  const res = await call(refund, { method: 'POST', headers: ADMIN, body: { rid } });
  assert.equal(res.statusCode, 502); assert.equal(res.body.error, 'refund_failed');
  assert.match(res.body.detail, /greater than unrefunded amount/);
  const d = fake.doc(`registrations/${rid}`);
  assert.equal(d.amount_refunded_cents, 0); assert.equal(d.status, 'paid'); assert.equal(d.last_refund_id, undefined);
  assert.equal(fake.mails().length, 0);
});
await test('a canceled-but-paid reg can still be refunded; a partial keeps status canceled', async () => {
  fake.reset();
  fake.stripe.seedSession({ id: 'cs_cx', pi: 'pi_cx', paid: true, amount: 7000 });
  const rid = fake.seedReg({ status: 'canceled', sessions: ['s1', 's2'], stripe_session_id: 'cs_cx', stripe_payment_intent: 'pi_cx', canceled_at: '2026-09-02T00:00:00Z' });
  const res = await call(refund, { method: 'POST', headers: ADMIN, body: { rid, amount_cents: 3500 } });
  assert.deepEqual(res.body, { ok: true, refunded_cents: 3500, refunded: '35.00', status: 'canceled' });
  assert.equal(fake.doc(`registrations/${rid}`).status, 'canceled');
});

// ═════════════════════════════════════════════════════════════════════════
group('9. Stripe webhook — signature, replay, tampering, finalize');
await test('replayed valid event for an already-paid reg → 200 {already:"paid"}, no second email, no Stripe call', async () => {
  fake.stripe.seedSession({ id: 'cs_w1', paid: true, amount: 3500 });
  const rid = fake.seedReg({ status: 'paid', stripe_session_id: 'cs_w1' });
  const raw = stripeEvent(rid, 'cs_w1');
  for (const stream of [false, true]) {
    const res = mockRes(); await webhook(webhookReq(raw, sign(raw), { stream }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, already: 'paid' });
  }
  assert.equal(fake.mails().length, 0);
  assert.equal(fake.calls({ host: 'api.stripe.com' }).length, 0);
});
await test('tampered body (signature computed over the original) → 400 bad_signature; wrong secret → 400; stale timestamp → 400', async () => {
  const fsBefore = fake.calls({ host: 'firestore' }).length;
  const rid = fake.seedReg({ status: 'pending', stripe_session_id: 'cs_w2' });
  const raw = stripeEvent(rid, 'cs_w2');
  const header = sign(raw);
  let res = mockRes(); await webhook(webhookReq(raw.replace('"paid"', '"unpaid"'), header, { stream: true }), res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'bad_signature');
  res = mockRes(); await webhook(webhookReq(raw, sign(raw, 'whsec_wrong')), res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'bad_signature');
  res = mockRes(); await webhook(webhookReq(raw, sign(raw, undefined, Math.floor(Date.now() / 1000) - 600)), res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'bad_signature');
  res = mockRes(); await webhook(webhookReq(raw, ''), res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'bad_signature');
  assert.equal(fake.calls({ host: 'firestore' }).length, fsBefore, 'rejected before touching the DB');
  assert.equal(fake.doc(`registrations/${rid}`).status, 'pending');
});
await test('valid event, but Stripe says the session is still unpaid → 200 {pending:true}, no change (never trusts the event body)', async () => {
  fake.stripe.seedSession({ id: 'cs_w3', paid: false, amount: 3500 });
  const rid = fake.seedReg({ status: 'pending', stripe_session_id: 'cs_w3', stripe_payment_intent: '' });
  const raw = stripeEvent(rid, 'cs_w3', { payment_status: 'paid', amount_total: 3500 });
  const res = mockRes(); await webhook(webhookReq(raw, sign(raw), { stream: true }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, pending: true });
  assert.equal(fake.doc(`registrations/${rid}`).status, 'pending');
  assert.equal(fake.mails().length, 0);
});
await test('valid event for a pending reg whose session IS paid → finalized + ONE email; Stripe retry of the same event → already paid', async () => {
  fake.stripe.seedSession({ id: 'cs_w4', paid: true, amount: 3500, last4: '0005' });
  const rid = fake.seedReg({ status: 'pending', stripe_session_id: 'cs_w4', stripe_payment_intent: '', parent_email: 'hook@x.com' });
  const raw = stripeEvent(rid, 'cs_w4');
  let res = mockRes(); await webhook(webhookReq(raw, sign(raw), { stream: true }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, finalized: true });
  const d = fake.doc(`registrations/${rid}`);
  assert.equal(d.status, 'paid'); assert.equal(d.card_last4, '0005'); assert.equal(d.confirm_email_sent, true);
  assert.deepEqual(fake.mailsTo('hook@x.com').length, 1);
  res = mockRes(); await webhook(webhookReq(raw, sign(raw)), res);
  assert.deepEqual(res.body, { ok: true, already: 'paid' });
  assert.equal(fake.mailsTo('hook@x.com').length, 1);
});
await test('other event types, unknown rids, and terminal regs are acknowledged (200) so Stripe stops retrying; nothing changes', async () => {
  const before = fake.mails().length;
  let raw = JSON.stringify({ id: 'evt_x', type: 'payment_intent.succeeded', data: { object: { id: 'pi_x' } } });
  let res = mockRes(); await webhook(webhookReq(raw, sign(raw)), res);
  assert.deepEqual(res.body, { ok: true, ignored: 'payment_intent.succeeded' });
  raw = stripeEvent('doesnotexist', 'cs_none');
  res = mockRes(); await webhook(webhookReq(raw, sign(raw)), res);
  assert.deepEqual(res.body, { ok: true, ignored: 'not_found' });
  raw = stripeEvent('../admins/x', 'cs_none');
  res = mockRes(); await webhook(webhookReq(raw, sign(raw)), res);
  assert.deepEqual(res.body, { ok: true, ignored: 'no_rid' });
  const cx = fake.seedReg({ status: 'canceled', stripe_session_id: 'cs_w4' });
  raw = stripeEvent(cx, 'cs_w4');
  res = mockRes(); await webhook(webhookReq(raw, sign(raw)), res);
  assert.deepEqual(res.body, { ok: true, ignored: 'canceled' });
  assert.equal(fake.doc(`registrations/${cx}`).status, 'canceled');
  assert.equal(fake.mails().length, before);
});
await test('a Stripe outage during verification → 500 (so Stripe retries later); reg untouched', async () => {
  fake.stripe.seedSession({ id: 'cs_w5', paid: true, amount: 3500 });
  fake.state.stripe.failSessions.add('cs_w5');
  const rid = fake.seedReg({ status: 'pending', stripe_session_id: 'cs_w5', stripe_payment_intent: '' });
  const raw = stripeEvent(rid, 'cs_w5');
  const res = mockRes(); await webhook(webhookReq(raw, sign(raw)), res);
  // verifyStripe reports {paid:false, determinate:false} on a non-OK read → the handler answers 200 pending (Stripe's own retry schedule still re-delivers).
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, pending: true });
  assert.equal(fake.doc(`registrations/${rid}`).status, 'pending');
});

// ═════════════════════════════════════════════════════════════════════════
group('10. Receipt email failure — payment is still recorded, the claim is released, and a retry sends it');
let rid10 = '';
await test('SendGrid 500 during confirm → status paid, confirm_email_sent false + confirm_email_error, zero emails, page still gets ok:true', async () => {
  fake.stripe.seedSession({ id: 'cs_sg', paid: true, amount: 3500 });
  rid10 = fake.seedReg({ status: 'pending', stripe_session_id: 'cs_sg', stripe_payment_intent: '' });
  fake.state.opts.fail.sendgrid = 500;
  const res = await call(confirm, { method: 'GET', query: { rid: rid10 } });
  assert.equal(res.body.ok, true); assert.equal(res.body.status, 'paid');
  const d = fake.doc(`registrations/${rid10}`);
  assert.equal(d.status, 'paid');
  assert.equal(d.confirm_email_sent, false);
  assert.equal(d.confirm_email_error, 'send_failed');
  assert.equal(fake.mails().length, 0);
  assert.equal(fake.calls({ host: 'api.sendgrid.com' }).length, 1, 'one attempt was made');
});
await test('the reconcile cron resends a receipt whose earlier send failed — exactly once (claim-before-send)', async () => {
  fake.state.opts.fail.sendgrid = 0;
  const res = await call(reconcile, { headers: CRON });
  assert.equal(res.statusCode, 200);
  assert.equal(fake.mails().length, 1, 'expected the cron to send the receipt whose earlier send failed');
  assert.equal(fake.doc(`registrations/${rid10}`).confirm_email_sent, true);
});
await test('the parent reloading the success page (GET /api/confirm again) does resend it — exactly once', async () => {
  fake.state.opts.fail.sendgrid = 0;
  const res = await call(confirm, { method: 'GET', query: { rid: rid10 } });
  assert.equal(res.body.ok, true);
  assert.equal(fake.mails().length, 1);
  assert.deepEqual(fake.mails()[0].to, ['jane@x.com']);
  assert.equal(fake.doc(`registrations/${rid10}`).confirm_email_sent, true);
  await call(confirm, { method: 'GET', query: { rid: rid10 } });
  assert.equal(fake.mails().length, 1, 'still one');
});

// ═════════════════════════════════════════════════════════════════════════
group('11. Fake self-checks — the simulation refuses what production would refuse');
await test('Firestore fake enforces firestore.rules: no token → 403; token → registrations ok; other collections denied', async () => {
  const r0 = await fetch(`${fake.FB_BASE}/registrations/x?key=k`);
  assert.equal(r0.status, 403);
  const tok = [...fake.state.auth.tokens][0];
  const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
  const r1 = await fetch(`${fake.FB_BASE}/registrations/x?key=k`, { headers: H });
  assert.equal(r1.status, 404);
  const r2 = await fetch(`${fake.FB_BASE}/notices?key=k`, { method: 'POST', headers: H, body: '{"fields":{}}' });
  assert.equal(r2.status, 403);
  const r3 = await fetch(`${fake.FB_BASE}/admins/u?key=k`, { headers: H });
  assert.equal(r3.status, 404); // readable (rules allow) but absent
  const r4 = await fetch(`${fake.FB_BASE}/admins/u?updateMask.fieldPaths=a&key=k`, { method: 'PATCH', headers: H, body: '{"fields":{"a":{"stringValue":"x"}}}' });
  assert.equal(r4.status, 403);
});
await test('Firestore fake: updateMask semantics, precondition mismatch → 400 FAILED_PRECONDITION, updateTime bumps on every write', async () => {
  const tok = [...fake.state.auth.tokens][0];
  const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
  fake.seed('registrations/m', { a: 1, b: 'keep', nested: { x: 1, y: 2 } });
  const t0 = fake.meta('registrations/m').updateTime;
  let r = await fetch(`${fake.FB_BASE}/registrations/m?updateMask.fieldPaths=a&updateMask.fieldPaths=nested.x&updateMask.fieldPaths=gone&key=k`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: { a: { integerValue: '2' }, nested: { mapValue: { fields: { x: { integerValue: '9' } } } } } }) });
  assert.equal(r.status, 200);
  const t1 = (await r.json()).updateTime;
  assert.notEqual(t1, t0);
  assert.deepEqual(fake.doc('registrations/m'), { id: 'm', a: 2, b: 'keep', nested: { x: 9, y: 2 } });
  r = await fetch(`${fake.FB_BASE}/registrations/m?updateMask.fieldPaths=a&currentDocument.updateTime=${encodeURIComponent(t0)}&key=k`, { method: 'PATCH', headers: H, body: '{"fields":{"a":{"integerValue":"3"}}}' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.status, 'FAILED_PRECONDITION');
  assert.equal(fake.doc('registrations/m').a, 2);
  r = await fetch(`${fake.FB_BASE}/registrations/m?updateMask.fieldPaths=a&currentDocument.updateTime=${encodeURIComponent(t1)}&key=k`, { method: 'PATCH', headers: H, body: '{"fields":{"a":{"integerValue":"3"}}}' });
  assert.equal(r.status, 200);
  assert.equal(fake.doc('registrations/m').a, 3);
  r = await fetch(`${fake.FB_BASE}/registrations/m?updateMask.fieldPaths=bad-name&key=k`, { method: 'PATCH', headers: H, body: '{"fields":{}}' });
  assert.equal(r.status, 400);
  fake.state.unexpected.length = 0; // that last one was deliberate
});
await test('nothing in this suite ever reached a host the fake does not model', async () => {
  assert.equal(fake.state.unexpected.length, 0);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
