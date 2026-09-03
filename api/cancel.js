// Vercel Serverless Function — /api/cancel  (admin only)
// POST { rid } — marks a registration canceled. Does NOT auto-refund; issue a
// refund separately via /api/refund if money needs to go back. Gated by ADMIN_PASSWORD.

import { fbConfigured, fbAdminConfigured, fsGet, fsPatchVerified } from './_firestore.js';

function ctEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function authed(req) {
  const want = process.env.ADMIN_PASSWORD || '';
  return !!want && ctEq(req.headers['x-admin-key'] || '', want); // header only — never a URL query param
}
function safeId(id) { return /^[A-Za-z0-9_-]{1,128}$/.test(String(id || '')); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: 'admin_not_configured' });
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!fbConfigured() || !fbAdminConfigured()) return res.status(503).json({ error: 'db_not_configured' });

  const b = req.body || {};
  if (!safeId(b.rid)) return res.status(400).json({ error: 'bad_rid' });
  const reg = await fsGet(`registrations/${b.rid}`);
  if (!reg) return res.status(404).json({ error: 'not_found' });

  // A pending registration still has a LIVE Stripe Checkout link (good for up to an hour). Kill it
  // first, so the parent can't pay into a record we've just declared dead. Best-effort: if Stripe
  // is unreachable we still cancel, and the webhook/confirm paths flag any late payment as
  // `paid_after_cancel` so it shows up in admin with a Refund button.
  let link_expired = false;
  if (reg.status === 'pending' && reg.stripe_session_id && process.env.STRIPE_SECRET_KEY) {
    try {
      const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(reg.stripe_session_id)}/expire`, {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
      });
      link_expired = r.ok;
    } catch (e) { /* best-effort */ }
  }
  const patch = { status: 'canceled', canceled_at: new Date().toISOString(), ...(link_expired ? { checkout_link_expired: true } : {}) };
  const w = await fsPatchVerified(`registrations/${b.rid}`, patch);
  if (!w.ok) return res.status(502).json({ error: 'update_failed' });
  const owed = (reg.status === 'paid') ? ((reg.amount_cents || 0) - (reg.amount_refunded_cents || 0)) : 0;
  return res.status(200).json({ ok: true, status: 'canceled', refund_owed: (owed / 100).toFixed(2) });
}
