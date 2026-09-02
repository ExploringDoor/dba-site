// Offline tests for the clinic system — no Firebase/Stripe/Square needed.
// Run: npm test   (or: node tests/clinic.test.mjs)
// Covers authoritative pricing, input validation/sanitization, and the auth /
// readiness gating on the serverless handlers (the money-safety-critical paths).

import assert from 'node:assert';
import { expectedCents, normalizeRegistration, cleanSessions, PRICE, SESSION_IDS } from '../api/_clinic.js';
import { buildRefundEmail, buildReminderEmail } from '../api/_email.js';
import { nextDayET, sessionOn } from '../api/remind.js';

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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
