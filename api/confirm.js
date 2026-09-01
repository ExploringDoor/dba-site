// Vercel Serverless Function — /api/confirm?rid=...
// Called by register-success.html after the parent returns from hosted checkout.
// Verifies the payment DIRECTLY with the provider (never trusts the redirect alone),
// flips the registration to "paid", and returns a small summary for the page.
// Idempotent: safe to call more than once. Shares all verify/finalize logic with
// the reconcile cron via _finalize.js so the two paths can never disagree.
//
// The provider (Stripe/Square) emails the official card receipt automatically.
// NOTE: no wildcard CORS — the success page is same-origin, and this response
// carries registrant info that must not be readable cross-origin.

import { fsGet } from './_firestore.js';
import { verifyPayment, finalizePaid } from './_finalize.js';

function safeId(id) { return /^[A-Za-z0-9_-]{1,128}$/.test(String(id || '')); }

// Minimal, non-sensitive recap for the success page. Deliberately omits the
// parent email and any contact info (the page doesn't need it, and this endpoint
// is unauthenticated).
function summary(reg) {
  return {
    title: reg.clinic_title || 'DBA Fall Clinics',
    amount: ((reg.amount_cents || 0) / 100).toFixed(2),
    players: (reg.players || []).map((p) => `${p.first} ${p.last}`.trim()),
    session_count: reg.session_count || 0,
    all_six: !!reg.all_six,
    status: reg.status || 'pending',
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const rid = (req.query && req.query.rid) || (req.body && req.body.rid);
  if (!safeId(rid)) return res.status(400).json({ error: 'bad_rid' });

  const reg = await fsGet(`registrations/${rid}`);
  if (!reg) return res.status(404).json({ error: 'not_found' });

  // Already finalized — return as-is (idempotent); finalizePaid backfills the
  // confirmation email if a prior attempt hadn't sent it.
  if (reg.status === 'paid') {
    const merged = await finalizePaid(rid, reg, {});
    return res.status(200).json({ ok: true, ...summary(merged) });
  }

  try {
    const v = await verifyPayment(reg);
    if (!v.paid) return res.status(200).json({ ok: false, status: reg.status || 'pending' });
    const merged = await finalizePaid(rid, reg, v.patch);
    return res.status(200).json({ ok: true, ...summary(merged) });
  } catch (e) {
    return res.status(200).json({ ok: false, status: reg.status || 'pending' });
  }
}
