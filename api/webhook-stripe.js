// Vercel Serverless Function — /api/webhook-stripe
// Stripe → us: the PRIMARY payment-confirmation path. Stripe calls this the instant a
// Checkout Session completes, so a registration is marked paid (and its confirmation
// email sent) even if the parent closes the tab before the success page ever loads.
// The success-page /api/confirm and the reconcile cron stay on as belt-and-suspenders.
//
// Security: every call is verified against the Stripe-Signature header — an HMAC-SHA256
// over the RAW request body using STRIPE_WEBHOOK_SECRET — so forged/unsigned calls are
// rejected. Setup: Stripe Dashboard → Developers → Webhooks → add endpoint
// https://<site>/api/webhook-stripe for event `checkout.session.completed`, then paste
// the signing secret (whsec_…) into Vercel as STRIPE_WEBHOOK_SECRET.
//
// Idempotent: finalizePaid no-ops on an already-paid registration and terminal statuses
// are never re-flipped, so Stripe's automatic retries are harmless.

import crypto from 'node:crypto';
import { fsGet, fsPatchVerified } from './_firestore.js';
import { verifyPayment, finalizePaid } from './_finalize.js';

export const config = { api: { bodyParser: false } }; // signature must be computed over the raw bytes

async function readRaw(req) {
  if (typeof req.body === 'string') return Buffer.from(req.body);
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

// Verify Stripe's signature header ("t=<unix>,v1=<hex>[,v1=<hex>…]") against the raw body.
// Exported so it can be unit-tested with a known secret. Rejects stale timestamps (replay).
export function verifySignature(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300) {
  if (!header || !secret) return false;
  let t = NaN;
  const v1s = [];
  for (const kv of String(header).split(',')) {
    const i = kv.indexOf('=');
    if (i < 0) continue;
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    if (k === 't') t = parseInt(v, 10);
    else if (k === 'v1') v1s.push(v);
  }
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex'), 'utf8');
  return v1s.some((sig) => {
    const s = Buffer.from(String(sig), 'utf8');
    return s.length === expected.length && crypto.timingSafeEqual(s, expected);
  });
}

function safeId(id) { return /^[A-Za-z0-9_-]{1,128}$/.test(String(id || '')); }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!secret) return res.status(503).json({ error: 'webhook_not_configured' });

  let raw;
  try { raw = await readRaw(req); } catch (e) { return res.status(400).json({ error: 'bad_body' }); }
  if (!verifySignature(raw, req.headers['stripe-signature'], secret)) return res.status(400).json({ error: 'bad_signature' });

  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'bad_json' }); }

  // Only completed checkouts matter. Acknowledge everything else (200) so Stripe won't retry.
  const type = event && event.type;
  if (type !== 'checkout.session.completed' && type !== 'checkout.session.async_payment_succeeded') {
    return res.status(200).json({ ok: true, ignored: type || 'unknown' });
  }
  const session = (event.data && event.data.object) || {};
  const rid = (session.metadata && session.metadata.rid) || session.client_reference_id || '';
  if (!safeId(rid)) return res.status(200).json({ ok: true, ignored: 'no_rid' });

  const reg = await fsGet(`registrations/${rid}`);
  if (!reg) return res.status(200).json({ ok: true, ignored: 'not_found' });
  if (reg.status === 'paid') return res.status(200).json({ ok: true, already: 'paid' });
  if (['canceled', 'refunded', 'abandoned', 'error'].includes(reg.status)) {
    // Never re-flip a terminal record — but if Stripe says money actually came in (a parent paid a
    // link that was still live when the admin cancelled), RECORD it so the dashboard shows a
    // "paid after cancel" flag with a working Refund button instead of silently holding the money.
    try {
      const v = await verifyPayment(reg);
      if (v.paid && !reg.paid_after_cancel) await fsPatchVerified(`registrations/${rid}`, Object.assign({ paid_after_cancel: true, paid_after_cancel_at: new Date().toISOString() }, v.patch || {}));
    } catch (e) { /* best-effort flag */ }
    return res.status(200).json({ ok: true, ignored: reg.status });
  }

  try {
    // Re-verify with Stripe's API via the SAME helper as /api/confirm and the cron, so all
    // three paths agree on what "paid" means and capture last4 / captured amount identically.
    const v = await verifyPayment(reg);
    if (!v.paid) return res.status(200).json({ ok: true, pending: true });
    await finalizePaid(rid, reg, v.patch);
    return res.status(200).json({ ok: true, finalized: true });
  } catch (e) {
    return res.status(500).json({ error: 'finalize_failed' }); // non-2xx → Stripe retries (what we want on a blip)
  }
}
