# DBA Clinic Registration System

Self-hosted clinic registration + payment + admin for Downer Basketball Academy,
replacing RYZER. Static pages + Vercel serverless functions + Firestore. Provider-
agnostic: **Stripe or Square**, flipped with one env var. No build step, no SDKs
(everything uses `fetch`).

## Pages
| File | Who | Purpose |
|------|-----|---------|
| `clinics.html` | Public | Fall-clinic landing page (info, pricing, CTA). |
| `register.html` | Public | Registration form → posts to `/api/checkout`. Shows "opens soon" until configured. |
| `register-success.html` | Public | Post-payment confirmation; calls `/api/confirm`. |
| `admin.html` | Admin | Dashboard (passcode-gated). `?demo=1` shows sample data, no backend. |

## API (`/api`)
| File | Purpose |
|------|---------|
| `checkout.js` | `GET` readiness · `POST` validate → create pending reg → open Stripe/Square hosted checkout. |
| `confirm.js` | Fast path: verify payment on return, mark paid, send confirmation email. |
| `reconcile.js` | Safety net (cron): finalize payments where the parent never returned; expire stale pendings. |
| `refund.js` | Admin: full/partial refund via the original provider. |
| `cancel.js` | Admin: mark a registration canceled. |
| `registrations.js` | Admin: list registrations + rollup for the dashboard. |
| `_clinic.js` | **Authoritative** pricing (`expectedCents`) + validation (`normalizeRegistration`). |
| `_firestore.js` | Firestore REST helper; server signs in as one admin user (no key file). |
| `_finalize.js` | Shared verify + mark-paid + confirmation-email logic (used by confirm + reconcile). |
| `_email.js` | SendGrid sender + branded confirmation email. |

## Money-safety design
- **Price is never trusted from the browser** — the server recomputes it in `expectedCents`.
- **Two ways a payment is finalized**: `confirm.js` (immediately, when the parent returns) and
  `reconcile.js` (a cron catches anyone who closed the tab). Both share `_finalize.js`, so they
  can't disagree, and confirmation email is guarded by `confirm_email_sent` (sent once).
- **Refunds** are clamped to the un-refunded balance (never over-refund) and go through the
  provider that took the payment.
- **Card receipts** are emailed by Stripe/Square automatically; `_email.js` only sends the
  branded "you're registered" note.

## Data
Firestore collection `registrations/{id}`. Browsers never touch Firestore directly — all reads/
writes go through the server's admin token. `firestore.rules` locks everything to that admin user.

## Config (Vercel env vars)
See `CLINIC-SETUP.md` for the full go-live checklist. Switch is `PAYMENT_PROVIDER=stripe|square`.

## Testing
```
npm test        # offline: pricing, validation, auth/readiness gating (no accounts needed)
```
Local preview (static only — the /api functions need `vercel dev` or a deploy):
```
npm run dev     # serves the pages on http://localhost:8899
```
Preview the dashboard without a backend: `admin.html?demo=1`.

## Editing the clinic
- **Sessions / dates / prices** live in `api/_clinic.js` (authoritative) and are mirrored for
  display in `register.html` (`SESSIONS`, `PRICE_*`) and `clinics.html`. Keep them in sync.
- Placeholder fall dates are marked with the dashed-pink `.tbd` style on `clinics.html`.
