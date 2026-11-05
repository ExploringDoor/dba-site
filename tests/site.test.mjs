// Offline tests for the two-site split (api/_site.js). Aces and Gregg Downer Basketball share ONE
// Firestore and ONE Stripe account, so Stripe sends every checkout to BOTH sites' webhooks and both
// sites' crons see every record. Each site must only finalize / email its OWN families, or a family
// gets a receipt in the other site's branding. Zero network.
// Run: npm test   (or: node tests/site.test.mjs)

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as fake from './_fake.js';
import { SITE_TAG, ownsRecord, ownsSession } from '../api/_site.js';
import { SHOOTATHON } from '../api/_shootathon.js';
import pledge from '../api/pledge.js';
import webhook from '../api/webhook-stripe.js';
import reconcile from '../api/reconcile.js';

fake.install();
const OTHER = SITE_TAG === 'aces' ? 'downer' : 'aces';

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => fake.assertClean()).then(
    () => { pass++; console.log('  ✓', name); },
    (e) => { fail++; console.log('  ✗', name, '\n       ', String(e && e.message || e).split('\n').join('\n       ')); }
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
async function call(handler, o) { const res = mockRes(); await handler(Object.assign({ method: 'GET', headers: {}, query: {}, body: {} }, o), res); return res; }
function sign(raw, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.`).update(raw).digest('hex')}`;
}
function hook(obj) { const raw = JSON.stringify({ id: 'evt_x', object: 'event', type: 'checkout.session.completed', data: { object: obj } }); return call(webhook, { method: 'POST', headers: { 'stripe-signature': sign(raw), 'content-type': 'application/json' }, body: raw }); }
const CRON = { authorization: `Bearer ${process.env.CRON_SECRET}` };
function seedEvent() {
  fake.seed(`shootathon/${SHOOTATHON.eventId}`, { title: 'Aces Shoot-a-Thon', open: true, org_goal_cents: 3000000,
    teams: [{ slug: 'varsity', name: 'Varsity', goal_cents: 1000000 }],
    players: [{ slug: 'jimmy-d', name: 'Jimmy D', team: 'varsity', goal_cents: 100000, makes: 0 }] });
}

console.log('\nsite tag (' + SITE_TAG + ')');
await test('untagged records and sessions belong to Downer', () => {
  assert.equal(ownsRecord({}), SITE_TAG === 'downer');
  assert.equal(ownsSession({ metadata: {} }), SITE_TAG === 'downer');
  assert.equal(ownsRecord({ site: SITE_TAG }), true);
  assert.equal(ownsRecord({ site: OTHER }), false);
});
await test('a donation is tagged on the record AND on the Stripe checkout', async () => {
  fake.reset(); seedEvent();
  const r = await call(pledge, { method: 'POST', body: { kind: 'flat', target_type: 'player', target_slug: 'jimmy-d', flat_cents: 5000, donor_name: 'Dana R', donor_email: 'dana@x.com' } });
  assert.equal(r.body.pay, true, JSON.stringify(r.body));
  assert.equal(fake.doc('pledges/' + r.body.id).site, SITE_TAG);
  const cs = fake.calls({ host: 'api.stripe.com', method: 'POST', path: '/v1/checkout/sessions' });
  assert.equal(cs[0].body['metadata[site]'], SITE_TAG);
  assert.equal(cs[0].body['payment_intent_data[metadata][site]'], SITE_TAG);
});
await test("webhook ignores the OTHER site's paid donation: no finalize, no receipt", async () => {
  fake.reset(); seedEvent();
  const r = await call(pledge, { method: 'POST', body: { kind: 'flat', target_type: 'player', target_slug: 'jimmy-d', flat_cents: 5000, donor_name: 'Dana R', donor_email: 'dana@x.com' } });
  const id = r.body.id, sid = fake.doc('pledges/' + id).stripe_session_id;
  fake.stripe.pay(sid);
  const before = fake.mails().length;
  const w = await hook({ id: sid, object: 'checkout.session', client_reference_id: id, metadata: { kind: 'donation', pledge_id: id, site: OTHER }, payment_status: 'paid' });
  assert.equal(w.statusCode, 200);
  assert.equal(w.body.ignored, 'other_site');
  assert.equal(fake.doc('pledges/' + id).status, 'pending');
  assert.equal(fake.mails().length, before);
  // ...and the same session tagged for THIS site is finalized.
  const w2 = await hook({ id: sid, object: 'checkout.session', client_reference_id: id, metadata: { kind: 'donation', pledge_id: id, site: SITE_TAG }, payment_status: 'paid' });
  assert.equal(w2.body.donation_finalized, true, JSON.stringify(w2.body));
  assert.equal(fake.doc('pledges/' + id).status, 'paid');
});
await test("reconcile cron leaves the OTHER site's pending registration alone", async () => {
  fake.reset();
  fake.stripe.seedSession({ id: 'cs_mine', paid: true, amount: 3500 });
  fake.stripe.seedSession({ id: 'cs_theirs', paid: true, amount: 3500 });
  const old = new Date(Date.now() - 3 * 86400000).toISOString();
  const mine = fake.seedReg({ status: 'pending', stripe_session_id: 'cs_mine', stripe_payment_intent: '', created: old, parent_email: 'mine@x.com' });
  const theirs = fake.seedReg({ status: 'pending', stripe_session_id: 'cs_theirs', stripe_payment_intent: '', created: old, parent_email: 'theirs@x.com', site: OTHER });
  fake.seed('registrations/_sessions', { s1: { canceled: false } });
  const res = await call(reconcile, { headers: CRON });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(fake.doc('registrations/' + mine).status, 'paid');
  assert.equal(fake.doc('registrations/' + theirs).status, 'pending');
  assert.equal(fake.mailsTo('theirs@x.com').length, 0);
  assert.equal(fake.calls({ host: 'api.stripe.com', path: '/v1/checkout/sessions/cs_theirs' }).length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
fake.uninstall();
if (fail) process.exit(1);
