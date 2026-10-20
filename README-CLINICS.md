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
| `admin.html` | Admin | Dashboard (passcode-gated). `?demo=1` shows sample data, no backend. Click a session chip for its roster + tap-to-check-in; **📊 Season report** = attendance by session/player, totals, print + CSV. |
| `checkin.html` | Staff | Clinic-day check-in for coaches/managers. Opens with `CHECKIN_PASSWORD` (or the admin passcode). Roster, parent/emergency/pickup phones, medical notes, tap-to-check-in — no payments or emails. |

## API (`/api`)
| File | Purpose |
|------|---------|
| `checkout.js` | `GET` readiness · `POST` validate → create pending reg → open Stripe/Square hosted checkout. |
| `confirm.js` | Fast path: verify payment on return, mark paid, send confirmation email. |
| `reconcile.js` | Safety net (cron): finalize payments where the parent never returned; expire stale pendings. |
| `refund.js` | Admin: full/partial refund via the original provider. |
| `cancel.js` | Admin: mark a registration canceled. |
| `registrations.js` | Admin: list registrations + rollup for the dashboard. |
| `checkin.js` | Staff/Admin: a session's roster (door-side fields only) + record/clear a check-in. Accepts `CHECKIN_PASSWORD` **or** `ADMIN_PASSWORD`. |
| `notify.js` | Admin: email every family registered for one Sunday (cancellation or update) in one SendGrid call; a cancellation also flags the date in `registrations/_sessions` so checkout refuses it, the reminder skips it, and check-in labels it. `reopen:true` clears the flag. |
| `_status.js` | Per-session status helpers (`sessionStatus`, `isCanceled`, `setSessionStatus`) over the reserved `registrations/_sessions` doc. |
| `remind.js` | Cron (daily, 4 PM ET): "clinic tomorrow" reminder email to each paid family, once per session. |
| `webhook-stripe.js` | Stripe webhook (signature-verified): finalizes a paid registration the moment Stripe confirms it, even if the parent never returns. |
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
Attendance lives on each registration as `attendance[sessionId][playerIndex] = ISO timestamp`
(written only by `/api/checkin`); the season report is computed from it in the browser.

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

---

# Shoot-a-Thon (per-made-shot donations)

A fundraiser bolted onto the same stack. Supporters **pledge** with no card; after the event
the admin enters each player's made-shot count and the system emails everyone a secure pay-link
for their computed total. A supporter backs a specific player (per made shot, optional cap) or
gives a flat one-time gift. **No stored cards** — each pay-link mints a fresh hosted checkout at
click-time (so an emailed link never expires). Reuses the same Stripe, **the same Stripe webhook**,
Firestore, SendGrid, and the admin passcode.

## Pages
| File | Who | Purpose |
|------|-----|---------|
| `donate.html` | Public | Pledge form + live thermometer. `?player=<slug>` deep-links a player. `?demo=1` = sample data, no backend. |
| `donate-pay.html` | Public | "Complete your donation" — the durable pay-link target (`?p=<pledgeId>`); its button hits `/api/pledge?pay=` which 302s to a fresh checkout. |
| `donate-success.html` | Public | Post-payment thank-you. |
| `shootathon.html` | Admin | Console (same passcode): event + roster setup, enter made shots, send pay-links, dashboard. `?demo=1` for a backend-free preview. |

## API
| File | Purpose |
|------|---------|
| `pledge.js` | Public. `GET` config + totals (thermometer) · `GET ?info=<id>` safe pledge summary · `GET ?pay=<id>` mint fresh checkout + 302 · `POST` record a pledge (no charge). |
| `shootathon.js` | Admin (x-admin-key). `config` (dashboard) · `set_event` · `set_makes` · `send_links` · `resend` · `cancel` · `sync`. |
| `_shootathon.js` | **Authoritative** amount math (`computePledgeCents`) + pledge validation (`normalizePledge`) + money bounds (`LIMITS`). |
| `webhook-stripe.js` | Extended: a `metadata.kind === 'donation'` checkout finalizes the pledge (its own path, shared verify). |
| `_finalize.js` | Added `finalizeDonationPaid` + `maybeSendDonationReceipt` (receipt sent once via `receipt_email_sent`). |
| `_email.js` | Added `buildPledgeEmail`, `buildPayLinkEmail`, `buildDonationReceiptEmail`. |

## Money-safety design
- **The charge is never trusted from the browser.** `send_links` recomputes each total from the
  stored pledge × the admin-entered makes (`computePledgeCents`), clamped to hard bounds.
- **Pay-links can't go stale.** The email links to our own `donate-pay.html?p=<id>`; the actual
  checkout session is created fresh when the donor clicks (hosted sessions expire within ~24h).
- **Finalize is shared.** The Stripe webhook (primary) and the admin **Sync** button both use
  `verifyPayment` + `finalizeDonationPaid`; the receipt is guarded by `receipt_email_sent`.
- **Deductibility stays honest.** Receipts state the gift supports the booster club (a 501(c)(3))
  which issues the official acknowledgment — the for-profit LLC only collects and remits.

## Data
Firestore `pledges/{id}` (one per pledge: `status` = pledged → invoiced → paid, plus no_charge /
canceled) and a single `shootathon/{eventId}` config doc (title, goal, open flag, `players[]` with
their `makes`). Browsers never touch Firestore — all via `/api`. **`firestore.rules` must allow the
`pledges` and `shootathon` collections** (added); re-publish the rules or writes are denied.

## Editing the Shoot-a-Thon
- **Players, goal, makes, and the open flag** are edited in the admin (`shootathon.html`) — no code
  change. **Money bounds** (min/max per shot, caps, max gift) live in `api/_shootathon.js`.
- Tests: `node tests/shootathon.test.mjs` (amount math, validation, auth, full pledge→pay→receipt
  flow against the fakes) — also part of `npm test`.
