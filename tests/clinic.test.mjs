// Offline tests for the clinic system — no Firebase/Stripe/Square needed.
// Run: npm test   (or: node tests/clinic.test.mjs)
// Covers authoritative pricing, input validation/sanitization, and the auth /
// readiness gating on the serverless handlers (the money-safety-critical paths).

import assert from 'node:assert';
import { expectedCents, normalizeRegistration, cleanSessions, PRICE, SESSION_IDS } from '../api/_clinic.js';
import { buildRefundEmail, buildReminderEmail } from '../api/_email.js';
import { nextDayET, sessionOn } from '../api/remind.js';
import webhook, { verifySignature } from '../api/webhook-stripe.js';
import checkin from '../api/checkin.js';
import notify from '../api/notify.js';
import { isCanceled, canceledIds } from '../api/_status.js';
import { buildNoticeEmail } from '../api/_email.js';
import { createHmac } from 'node:crypto';

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ✓', name); },
    (e) => { fail++; console.log('  ✗', name, '\n      ', e.message); }
  );
}
function mockRes() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (j) => { r.body = j; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.end = () => r;
  return r;
}
function mockReq(o) { return Object.assign({ method: 'GET', headers: {}, query: {}, body: {} }, o); }
const GOOD = {
  sessions: ['s1', 's2'],
  players: [{ first: 'Kobe', last: 'B', dob: '2015-01-01' }],
  parent_email: 'a@b.com', parent_name: 'P', parent_phone: '1',
  emerg_name: 'E', emerg_phone: '2', waiver_agree: true, waiver_name: 'P Signed',
};

console.log('\n_clinic pricing + validation');
await test('single session = per-session price', () => assert.equal(expectedCents({ sessions: ['s1'], players: [{}] }), PRICE.perSessionCents));
await test('all six = bundle price (not 6×)', () => {
  assert.equal(expectedCents({ sessions: SESSION_IDS.slice(), players: [{}] }), PRICE.allSixCents);
  assert.ok(PRICE.allSixCents < 6 * PRICE.perSessionCents);
});
await test('per-player multiplies by player count', () => assert.equal(expectedCents({ sessions: ['s1', 's2', 's3'], players: [{}, {}] }), 3 * PRICE.perSessionCents * 2));
await test('duplicate + bogus sessions are de-duped/rejected', () => assert.equal(expectedCents({ sessions: ['s1', 's1', 's9', 'x'], players: [{}] }), PRICE.perSessionCents));
await test('no sessions or no players = 0', () => {
  assert.equal(expectedCents({ sessions: [], players: [{}] }), 0);
  assert.equal(expectedCents({ sessions: ['s1'], players: [] }), 0);
});
await test('cleanSessions returns canonical order', () => assert.deepEqual(cleanSessions(['s3', 's1', 's1']), ['s1', 's3']));
await test('normalize rejects bad email', () => assert.equal(normalizeRegistration({ ...GOOD, parent_email: 'nope' }).error, 'bad_email'));
await test('normalize rejects missing waiver signature', () => assert.equal(normalizeRegistration({ ...GOOD, waiver_name: '' }).error, 'waiver_required'));
await test('normalize rejects player missing dob', () => assert.equal(normalizeRegistration({ ...GOOD, players: [{ first: 'A', last: 'B' }] }).error, 'incomplete_player'));
await test('normalize rejects no sessions', () => assert.equal(normalizeRegistration({ ...GOOD, sessions: [] }).error, 'no_sessions'));
await test('normalize accepts a good body + captures pickup', () => {
  const r = normalizeRegistration({ ...GOOD, pickup_name: 'Gran', pickup_phone: '5' });
  assert.ok(r.ok); assert.equal(r.reg.pickup_name, 'Gran'); assert.equal(r.reg.player_count, 1);
});
await test('normalize strips HTML metacharacters from names (anti-XSS at intake)', () => {
  const r = normalizeRegistration({ ...GOOD, players: [{ first: '<img src=x onerror=alert(1)>', last: 'B', dob: '2015-01-01' }], parent_name: 'Al<script>ert', allergies: 'nut <b>allergy</b>', medical_conditions: 'asthma <x>' });
  assert.ok(r.ok);
  assert.ok(!/[<>]/.test(r.reg.players[0].first), 'player name must have no angle brackets');
  assert.ok(!/[<>]/.test(r.reg.parent_name), 'parent name must have no angle brackets');
  assert.ok(!/[<>]/.test(r.reg.allergies), 'allergies must have no angle brackets');
  assert.ok(!/[<>]/.test(r.reg.medical_conditions), 'medical conditions must have no angle brackets');
});
await test('normalize caps runaway player list', () => assert.equal(normalizeRegistration({ ...GOOD, players: Array(20).fill({ first: 'A', last: 'B', dob: 'x' }) }).error, 'too_many_players'));
await test('honeypot (company field) rejects bots', () => assert.equal(normalizeRegistration({ ...GOOD, company: 'AcmeBot' }).error, 'spam'));
await test('honeypot (dba_ref field) rejects bots', () => assert.equal(normalizeRegistration({ ...GOOD, dba_ref: 'http://spam' }).error, 'spam'));
await test('dob typo guard: garbage / mis-typed year → bad_dob; a real kid passes', () => {
  assert.equal(normalizeRegistration({ ...GOOD, players: [{ first: 'A', last: 'B', dob: '0216-05-03' }] }).error, 'bad_dob');
  assert.equal(normalizeRegistration({ ...GOOD, players: [{ first: 'A', last: 'B', dob: '1990-05-03' }] }).error, 'bad_dob');
  assert.equal(normalizeRegistration({ ...GOOD, players: [{ first: 'A', last: 'B', dob: 'May 3 2015' }] }).error, 'bad_dob');
  assert.equal(normalizeRegistration({ ...GOOD, players: [{ first: 'A', last: 'B', dob: '2018-05-03' }] }).ok, true);
});
await test('parent email is stored lower-cased (so the same family always matches)', () => {
  assert.equal(normalizeRegistration({ ...GOOD, parent_email: ' Jane.Doe@Gmail.com ' }).reg.parent_email, 'jane.doe@gmail.com');
});

console.log('\ncheckout handler (no env configured)');
const checkout = (await import('../api/checkout.js')).default;
await test('GET readiness reports not-ready with no env', async () => {
  const res = mockRes(); await checkout(mockReq({ method: 'GET' }), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.ready, false);
});
await test('POST with bad body → 400 before any charge', async () => {
  const res = mockRes(); await checkout(mockReq({ method: 'POST', body: { sessions: [], players: [] } }), res);
  assert.equal(res.statusCode, 400);
});
await test('POST valid body but unconfigured → 503 not_configured (no reg created)', async () => {
  const res = mockRes(); await checkout(mockReq({ method: 'POST', body: GOOD }), res);
  assert.equal(res.statusCode, 503); assert.equal(res.body.error, 'not_configured');
});

console.log('\nadmin auth gating');
const registrations = (await import('../api/registrations.js')).default;
const refund = (await import('../api/refund.js')).default;
const cancel = (await import('../api/cancel.js')).default;
delete process.env.ADMIN_PASSWORD;
await test('registrations without ADMIN_PASSWORD → 503', async () => {
  const res = mockRes(); await registrations(mockReq({ method: 'GET' }), res);
  assert.equal(res.statusCode, 503);
});
process.env.ADMIN_PASSWORD = 'secret-pass';
await test('registrations wrong key → 401', async () => {
  const res = mockRes(); await registrations(mockReq({ method: 'GET', headers: { 'x-admin-key': 'wrong' } }), res);
  assert.equal(res.statusCode, 401);
});
await test('registrations right key but no DB → 503 db_not_configured (not 200)', async () => {
  const res = mockRes(); await registrations(mockReq({ method: 'GET', headers: { 'x-admin-key': 'secret-pass' } }), res);
  assert.equal(res.statusCode, 503); assert.equal(res.body.error, 'db_not_configured');
});
await test('refund wrong key → 401', async () => {
  const res = mockRes(); await refund(mockReq({ method: 'POST', headers: { 'x-admin-key': 'wrong' }, body: { rid: 'x' } }), res);
  assert.equal(res.statusCode, 401);
});
await test('cancel wrong key → 401', async () => {
  const res = mockRes(); await cancel(mockReq({ method: 'POST', headers: { 'x-admin-key': 'wrong' }, body: { rid: 'x' } }), res);
  assert.equal(res.statusCode, 401);
});
await test('refund rejects malformed rid even with right key (bad_rid, not a charge)', async () => {
  const res = mockRes(); await refund(mockReq({ method: 'POST', headers: { 'x-admin-key': 'secret-pass' }, body: { rid: '../admins/x' } }), res);
  assert.ok(res.statusCode === 400 || res.statusCode === 503); // 400 bad_rid, or 503 if DB gate hits first
});

await test('buildRefundEmail renders a branded full-refund receipt', () => {
  const reg = { id: 'abc123', clinic_title: 'DBA Fall Clinics 2026', players: [{ first: 'Testy', last: 'M' }], amount_cents: 3800, amount_refunded_cents: 3800, paid_via: 'Stripe', card_last4: '4242' };
  const em = buildRefundEmail(reg, 3800, true);
  assert.match(em.subject, /Refund processed/);
  assert.match(em.html, /REFUND RECEIPT/);
  assert.match(em.html, /abc123/);
  assert.match(em.html, /\$38\.00/);
  assert.ok(!/Partial refund/.test(em.html), 'full refund should not show the partial note');
});
await test('buildRefundEmail: a policy refund (fee kept) says the fee is non-refundable, not "partial"', () => {
  const reg = { id: 'abc123', clinic_title: 'DBA', players: [{ first: 'T', last: 'M' }], amount_cents: 3500, amount_refunded_cents: 3000, paid_via: 'Stripe', card_last4: '4242' };
  const em = buildRefundEmail(reg, 3000, true);
  assert.ok(em.html.includes('$5.00') && em.html.includes('non-refundable') && !em.html.includes('Partial refund'));
});
await test('buildRefundEmail notes a partial refund with running total', () => {
  const reg = { id: 'abc123', clinic_title: 'DBA', players: [{ first: 'T', last: 'M' }], amount_cents: 3800, amount_refunded_cents: 1000 };
  const em = buildRefundEmail(reg, 1000, false);
  assert.match(em.html, /Partial refund/);
  assert.match(em.html, /\$10\.00 of \$38\.00/);
});

await test('nextDayET uses Eastern time, not UTC, before adding a day', () => {
  assert.equal(nextDayET(new Date('2026-09-26T20:00:00Z')), '2026-09-27'); // 4 pm EDT Sat → Sun
  assert.equal(nextDayET(new Date('2026-09-27T03:30:00Z')), '2026-09-27'); // 11:30 pm EDT Sat (already Sun in UTC) → still Sun
  assert.equal(nextDayET(new Date('2026-10-31T20:00:00Z')), '2026-11-01'); // eve of the last session
});
await test('sessionOn matches a session date and returns null otherwise', () => {
  assert.equal(sessionOn('2026-09-27').id, 's1');
  assert.equal(sessionOn('2026-11-01').id, 's6');
  assert.equal(sessionOn('2026-09-28'), null);
});
await test('buildReminderEmail names the player, the date, and where to park', () => {
  const em = buildReminderEmail({ players: [{ first: 'Maya', last: 'Avery' }] }, sessionOn('2026-10-04'));
  assert.match(em.subject, /Reminder: clinic tomorrow/);
  assert.match(em.subject, /Oct 4/);
  assert.match(em.html, /Maya Avery/);
  assert.match(em.html, /lot right by the gymnasium/);
});

await test('verifySignature accepts a valid Stripe signature, rejects wrong secret / stale / tampered', () => {
  const secret = 'whsec_testsecret', now = 1700000000;
  const body = Buffer.from('{"id":"evt_1","type":"checkout.session.completed"}');
  const sig = createHmac('sha256', secret).update(`${now}.`).update(body).digest('hex');
  assert.equal(verifySignature(body, `t=${now},v1=${sig}`, secret, now), true);
  assert.equal(verifySignature(body, `t=${now},v1=${sig}`, 'whsec_wrong', now), false);            // wrong secret
  assert.equal(verifySignature(body, `t=${now},v1=${sig}`, secret, now + 1000), false);             // stale → replay-protected
  assert.equal(verifySignature(Buffer.from('tampered'), `t=${now},v1=${sig}`, secret, now), false); // body changed
});
await test('webhook → 503 when STRIPE_WEBHOOK_SECRET is unset', async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const res = mockRes(); await webhook(mockReq({ method: 'POST', body: '{}' }), res);
  assert.equal(res.statusCode, 503);
});
await test('webhook → 400 bad_signature on an unsigned call (forgery blocked)', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
  const res = mockRes(); await webhook(mockReq({ method: 'POST', body: '{}' }), res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'bad_signature');
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

// ── /api/checkin (coach check-in) ──
await test('checkin → 401 with a wrong key', async () => {
  const res = mockRes(); await checkin(mockReq({ method: 'GET', headers: { 'x-checkin-key': 'wrong' }, query: { session: 's1' } }), res);
  assert.equal(res.statusCode, 401);
});
await test('checkin accepts the ADMIN passcode too (auth passes → 400 bad_session, not 401)', async () => {
  const res = mockRes(); await checkin(mockReq({ method: 'GET', headers: { 'x-admin-key': 'secret-pass' }, query: { session: 'nope' } }), res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'bad_session');
});
await test('checkin accepts a separate CHECKIN_PASSWORD via x-checkin-key (coach role)', async () => {
  process.env.CHECKIN_PASSWORD = 'coach-pass';
  const res = mockRes(); await checkin(mockReq({ method: 'GET', headers: { 'x-checkin-key': 'coach-pass' }, query: { session: 's1' } }), res);
  assert.equal(res.statusCode, 503); assert.equal(res.body.error, 'db_not_configured'); // got past auth + validation
  delete process.env.CHECKIN_PASSWORD;
});
await test('checkin GET with no session lists the 6 sessions without needing the DB', async () => {
  const res = mockRes(); await checkin(mockReq({ method: 'GET', headers: { 'x-admin-key': 'secret-pass' } }), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.sessions.length, 6); assert.equal(res.body.sessions[0].date, '2026-09-27');
});
await test('checkin POST validates rid / session / player before touching the DB', async () => {
  let res = mockRes(); await checkin(mockReq({ method: 'POST', headers: { 'x-admin-key': 'secret-pass' }, body: { rid: '../admins/x', session: 's1', player: 0, present: true } }), res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'bad_rid');
  res = mockRes(); await checkin(mockReq({ method: 'POST', headers: { 'x-admin-key': 'secret-pass' }, body: { rid: 'abc', session: 's9', player: 0, present: true } }), res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'bad_session');
  res = mockRes(); await checkin(mockReq({ method: 'POST', headers: { 'x-admin-key': 'secret-pass' }, body: { rid: 'abc', session: 's1', player: -1, present: true } }), res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'bad_player');
});

// ── /api/notify (session cancellation / notices) ──
await test('notify → 401 with a wrong key (the coach passcode does NOT open it)', async () => {
  process.env.CHECKIN_PASSWORD = 'coach-pass';
  const res = mockRes(); await notify(mockReq({ method: 'POST', headers: { 'x-admin-key': 'coach-pass' }, body: { session: 's1', message: 'x' } }), res);
  assert.equal(res.statusCode, 401);
  delete process.env.CHECKIN_PASSWORD;
});
await test('notify validates session + message before touching the DB', async () => {
  let res = mockRes(); await notify(mockReq({ method: 'POST', headers: { 'x-admin-key': 'secret-pass' }, body: { session: 's9', message: 'x' } }), res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'bad_session');
  res = mockRes(); await notify(mockReq({ method: 'POST', headers: { 'x-admin-key': 'secret-pass' }, body: { session: 's2', message: '   ' } }), res);
  assert.equal(res.statusCode, 400); assert.equal(res.body.error, 'bad_message');
  res = mockRes(); await notify(mockReq({ method: 'POST', headers: { 'x-admin-key': 'secret-pass' }, body: { session: 's2', message: 'Cancelled for snow', cancel: true } }), res);
  assert.equal(res.statusCode, 503); assert.equal(res.body.error, 'db_not_configured'); // valid → got as far as the DB
});
await test('session status helpers', () => {
  const st = { s2: { canceled: true, canceled_at: '2026-10-03T12:00:00Z' }, s3: { canceled: false } };
  assert.equal(isCanceled(st, 's2'), true); assert.equal(isCanceled(st, 's3'), false); assert.equal(isCanceled(st, 's1'), false); assert.equal(isCanceled(null, 's1'), false);
  assert.deepEqual(canceledIds(st), ['s2']); assert.deepEqual(canceledIds({}), []);
});
await test('buildNoticeEmail: cancellation banner, escaped message, per-family greeting tag, text part', () => {
  const m = buildNoticeEmail({ id: 's2', label: 'Session 2 — Sun, Oct 4', date: '2026-10-04' }, { cancel: true, message: 'Gym is closed <today>.\nSee you Oct 11!' });
  assert.equal(m.subject, 'Clinic cancelled — Sun, Oct 4');
  assert.ok(m.html.includes('SESSION CANCELLED') && m.html.includes('Sun, Oct 4 clinic is cancelled'));
  assert.ok(m.html.includes('&lt;today&gt;') && !m.html.includes('<today>'), 'message is HTML-escaped');
  assert.ok(m.html.includes('See you Oct 11!') && m.html.includes('<br>'), 'line breaks preserved');
  assert.ok(m.html.includes('Hi -parent-,') && m.text.includes('Hi -parent-,'), 'greeting uses the substitution tag');
  const g = buildNoticeEmail({ id: 's3', label: 'Session 3 — Sun, Oct 11' }, { subject: 'Bring a jacket', message: 'Gym is chilly.' });
  assert.equal(g.subject, 'Bring a jacket'); assert.ok(g.html.includes('CLINIC UPDATE') && !g.html.includes('cancelled'));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
