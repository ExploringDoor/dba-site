// Shared payment finalize + verify helpers, used by BOTH the fast path
// (api/confirm.js, when the parent returns) and the safety net (api/reconcile.js,
// a cron that catches payments where the parent never came back).
//
// Keeping this logic in one place means the two paths can never disagree about
// what "paid" means or send two different confirmation emails.
//
// verify* returns { paid, determinate, patch }:
//   determinate=false means we COULD NOT tell (provider unreachable / error) — callers
//   must NOT treat that as "unpaid" (never abandon a possibly-real payment on an outage).

import { fsPatch, fsPatchVerified, fsGetMeta } from './_firestore.js';
import { sendMail, buildConfirmationEmail, emailConfigured, ADMIN_EMAIL } from './_email.js';

// ── Verify with Stripe: was the Checkout Session actually paid? ──
export async function verifyStripe(reg) {
  if (!reg.stripe_session_id) return { paid: false, determinate: true }; // no session was ever created
  let d;
  try {
    const r = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(reg.stripe_session_id)}?expand[]=payment_intent.latest_charge`,
      { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
    );
    d = await r.json();
    if (!r.ok) return { paid: false, determinate: false }; // couldn't read — inconclusive
  } catch (e) {
    return { paid: false, determinate: false };
  }
  const paid = d.payment_status === 'paid';
  let last4 = '', payId = '';
  const hdr = { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` };
  const cardLast4 = (ch) => (ch && ch.payment_method_details && ch.payment_method_details.card && ch.payment_method_details.card.last4) || '';
  let pi = d.payment_intent;
  // The expand doesn't always nest — Stripe can return payment_intent as a bare id string.
  // Fetch it (with its charge) so we still capture last4. Best-effort: never affects `paid`.
  if (typeof pi === 'string' && pi) {
    payId = pi;
    try {
      const pr = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(pi)}?expand[]=latest_charge`, { headers: hdr });
      pi = await pr.json();
    } catch (e) { pi = null; }
  }
  if (pi && typeof pi === 'object') {
    payId = pi.id || payId;
    let ch = pi.latest_charge;
    if (typeof ch === 'string' && ch) {
      try { const cr = await fetch(`https://api.stripe.com/v1/charges/${encodeURIComponent(ch)}`, { headers: hdr }); ch = await cr.json(); } catch (e) { ch = null; }
    }
    last4 = cardLast4(ch);
  }
  return { paid, determinate: true, patch: { stripe_payment_intent: payId, card_last4: last4, paid_via: 'Stripe', amount_captured_cents: (typeof d.amount_total === 'number' ? d.amount_total : null) } };
}

// ── Verify with Square: is the order COMPLETED? ──
export async function verifySquare(reg) {
  if (!reg.square_order_id) return { paid: false, determinate: true };
  const ENV = (process.env.SQUARE_ENVIRONMENT || 'sandbox').toLowerCase();
  const API = ENV === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
  const headers = { 'Square-Version': '2024-10-17', Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}` };
  let d;
  try {
    const r = await fetch(`${API}/v2/orders/${encodeURIComponent(reg.square_order_id)}`, { headers });
    d = await r.json();
    if (!r.ok || !d.order) return { paid: false, determinate: false };
  } catch (e) {
    return { paid: false, determinate: false };
  }
  const paid = d.order.state === 'COMPLETED';
  const captured = d.order.total_money && typeof d.order.total_money.amount === 'number' ? d.order.total_money.amount : null;
  let last4 = '', payId = '';
  const tender = (d.order.tenders || [])[0];
  if (tender) {
    payId = tender.payment_id || tender.id || '';
    if (payId) {
      try {
        const pr = await fetch(`${API}/v2/payments/${encodeURIComponent(payId)}`, { headers });
        const pd = await pr.json();
        const card = pd && pd.payment && pd.payment.card_details && pd.payment.card_details.card;
        if (card) last4 = card.last_4 || '';
      } catch (e) { /* last4 is best-effort */ }
    }
  }
  return { paid, determinate: true, patch: { square_payment_id: payId, card_last4: last4, paid_via: 'Square', amount_captured_cents: captured } };
}

export async function verifyPayment(reg) {
  return reg.payment_provider === 'square' ? verifySquare(reg) : verifyStripe(reg);
}

// Send the branded confirmation ONCE, even when the webhook, the parent's return (confirm)
// and the reconcile cron all finalize the same payment within the same few seconds.
// "Claim before send": re-read the record, then flip confirm_email_sent with a Firestore
// precondition on its updateTime — only the one caller whose write lands sends the email.
// If the send then fails, the claim is released so the cron can try again later.
export async function maybeSendConfirmation(rid, reg) {
  if (reg.confirm_email_sent || !emailConfigured() || !reg.parent_email) return false;
  const cur = await fsGetMeta(`registrations/${rid}`);
  if (!cur || !cur.doc || cur.doc.confirm_email_sent) return false;
  const claim = await fsPatchVerified(`registrations/${rid}`, { confirm_email_sent: true, confirm_email_at: new Date().toISOString() }, 2, { ifUpdateTime: cur.updateTime });
  if (!claim.ok) return false; // another path already claimed it (or the write failed — the cron will revisit)
  const { subject, html } = buildConfirmationEmail(Object.assign({}, cur.doc, reg));
  const ok = await sendMail({ to: reg.parent_email, subject, html, bcc: ADMIN_EMAIL });
  if (!ok) await fsPatch(`registrations/${rid}`, { confirm_email_sent: false, confirm_email_error: 'send_failed' });
  return ok;
}

// Mark a verified-paid registration paid (idempotent), then send confirmation.
// Returns the merged reg. `verifyPatch` carries processor payment ids + last4 +
// the amount the provider actually captured (flagged if it differs from our price).
export async function finalizePaid(rid, reg, verifyPatch) {
  if (reg.status === 'paid') { await maybeSendConfirmation(rid, reg); return reg; }
  const vp = verifyPatch || {};
  const patch = Object.assign({ status: 'paid', paid_at: new Date().toISOString() }, vp);
  // Defense-in-depth: money is real, so we still mark paid, but flag any mismatch
  // between what the provider captured and our authoritative price for admin review.
  if (typeof vp.amount_captured_cents === 'number' && typeof reg.amount_cents === 'number' && vp.amount_captured_cents !== reg.amount_cents) {
    patch.amount_mismatch = true;
  }
  const w = await fsPatchVerified(`registrations/${rid}`, patch);
  if (!w.ok) return reg; // couldn't record "paid" — don't email a receipt for a record that still says pending; the cron retries
  const merged = Object.assign({}, reg, patch);
  await maybeSendConfirmation(rid, merged);
  return merged;
}
