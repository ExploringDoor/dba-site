// Vercel Serverless Function — /api/refund  (admin only)
// POST { rid, amount_cents? } — full refund if amount omitted, else a partial.
// Refunds through the SAME provider that took the payment, then updates Firestore.
// Refundability is based on MONEY (a captured payment with an un-refunded balance),
// not status — so a canceled-but-paid registration can still be refunded.
// Auth: ADMIN_PASSWORD via the x-admin-key header only (never a URL query param).

import { fbConfigured, fbAdminConfigured, fsGetMeta, fsPatchVerified } from './_firestore.js';
import { sendMail, buildRefundEmail, ADMIN_EMAIL } from './_email.js';

// Constant-time string compare (avoids leaking the passcode via timing).
function ctEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function authed(req) {
  const want = process.env.ADMIN_PASSWORD || '';
  return !!want && ctEq(req.headers['x-admin-key'] || '', want);
}
function safeId(id) { return /^[A-Za-z0-9_-]{1,128}$/.test(String(id || '')); }

async function refundStripe(reg, cents, key) {
  if (!reg.stripe_payment_intent) throw new Error('no_payment_intent');
  const params = new URLSearchParams();
  params.set('payment_intent', reg.stripe_payment_intent);
  params.set('amount', String(cents));
  const r = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': key, // so a network retry can't refund twice
    },
    body: params.toString(),
  });
  const d = await r.json();
  if (!r.ok || !d.id) throw new Error('stripe: ' + ((d.error && d.error.message) || ('http ' + r.status)));
  return { id: d.id };
}

async function refundSquare(reg, cents, key) {
  if (!reg.square_payment_id) throw new Error('no_payment_id');
  const ENV = (process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();
  const API = ENV === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
  const r = await fetch(`${API}/v2/refunds`, {
    method: 'POST',
    headers: { 'Square-Version': '2024-10-17', Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idempotency_key: key, // derived from record state — identical concurrent partials collapse into one
      payment_id: reg.square_payment_id,
      amount_money: { amount: cents, currency: 'USD' },
    }),
  });
  const d = await r.json();
  const rf = d && d.refund;
  if (!r.ok || !rf) throw new Error('square: ' + ((d.errors && d.errors[0] && (d.errors[0].detail || d.errors[0].code)) || ('http ' + r.status)));
  return { id: rf.id };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: 'admin_not_configured' });
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!fbConfigured() || !fbAdminConfigured()) return res.status(503).json({ error: 'db_not_configured' });

  const b = req.body || {};
  if (!safeId(b.rid)) return res.status(400).json({ error: 'bad_rid' });
  const meta = await fsGetMeta(`registrations/${b.rid}`);
  if (!meta) return res.status(404).json({ error: 'not_found' });
  const reg = meta.doc;

  // Refundable when a real payment was captured and money remains un-refunded —
  // regardless of paid / refunded / canceled status.
  const hasPayment = !!(reg.stripe_payment_intent || reg.square_payment_id);
  if (!hasPayment) return res.status(400).json({ error: 'not_refundable' });
  const already = reg.amount_refunded_cents || 0;
  const maxRefund = (reg.amount_cents || 0) - already;
  if (maxRefund <= 0) return res.status(400).json({ error: 'already_fully_refunded' });

  let cents = Number.isFinite(b.amount_cents) ? Math.round(b.amount_cents) : maxRefund;
  if (cents <= 0) return res.status(400).json({ error: 'bad_amount' });
  if (cents > maxRefund) cents = maxRefund; // never over-refund

  let out = null;
  try {
    // Idempotency key derived from the record's STATE, not a random nonce: two admin tabs firing
    // the same partial within a second collapse into ONE refund at the processor, while a later,
    // different partial (different `already`) is correctly distinct.
    const key = `rf_${reg.id}_${already}_${cents}`.slice(0, 120);
    out = reg.payment_provider === 'square' ? await refundSquare(reg, cents, key) : await refundStripe(reg, cents, key);
    const newRefunded = already + cents;
    const fullyRefunded = newRefunded >= (reg.amount_cents || 0);
    const patch = {
      amount_refunded_cents: newRefunded,
      // Fully refunded → 'refunded'; partial → keep the current status (don't un-cancel).
      status: fullyRefunded ? 'refunded' : (reg.status || 'paid'),
      last_refund_id: out.id || '',
      last_refund_at: new Date().toISOString(),
    };
    // Conditional write: if another tab changed this record in the meantime, do NOT overwrite it.
    const w = await fsPatchVerified(`registrations/${b.rid}`, patch, 4, { ifUpdateTime: meta.updateTime });
    if (!w.ok) {
      // MONEY WENT OUT at the processor but our record didn't update. Say so loudly, and don't
      // email a receipt (the admin must reload and reconcile before doing anything else).
      return res.status(500).json({
        error: 'refund_sent_but_record_not_updated', refund_id: out.id || '', refunded_cents: cents,
        message: `The processor refunded $${(cents / 100).toFixed(2)} (refund ${out.id || ''}), but this registration's record could not be updated — it may have been changed by another admin tab. Reload the dashboard and check the amount before doing anything else. Do NOT refund again.`,
      });
    }

    // Branded refund receipt to the parent (best-effort — a mail failure must never
    // fail the refund itself, which has already gone through at the processor).
    try {
      if (reg.parent_email) {
        const merged = { ...reg, ...patch };
        const em = buildRefundEmail(merged, cents, fullyRefunded);
        await sendMail({ to: reg.parent_email, subject: em.subject, html: em.html, bcc: ADMIN_EMAIL });
      }
    } catch (e) { /* swallow — refund already succeeded */ }

    return res.status(200).json({ ok: true, refunded_cents: newRefunded, refunded: (newRefunded / 100).toFixed(2), status: patch.status });
  } catch (e) {
    // If the processor DID refund (out.id set) and something later threw, say so — never let
    // "refund_failed" tempt the admin into refunding twice.
    if (out && out.id) return res.status(500).json({ error: 'refund_sent_but_record_not_updated', refund_id: out.id, refunded_cents: cents, message: `The processor refunded $${(cents / 100).toFixed(2)} (refund ${out.id}) but updating the record failed. Reload and check before doing anything else. Do NOT refund again.` });
    return res.status(502).json({ error: 'refund_failed', detail: String(e.message || e).slice(0, 200) });
  }
}
