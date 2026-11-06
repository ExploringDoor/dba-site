// Refund through the SAME provider that took the payment. Shared by /api/refund (clinic
// registrations) and /api/shootathon (donations). `reg` is the Firestore record (a registration or a pledge): it carries
// stripe_payment_intent or square_payment_id. `key` is an idempotency key derived from the
// record's state, so a retry or a second admin tab can never refund twice.

export async function refundStripe(reg, cents, key) {
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

export async function refundSquare(reg, cents, key) {
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
