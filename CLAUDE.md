# Downer Basketball Academy — site notes

Static site → GitHub (`ExploringDoor/dba-site`) → Vercel auto-deploy. The owner (Adam)
is **non-technical** and works in the Claude Code desktop app — guide via the app, not
the terminal, and don't push to git or change accounts without being asked.

## Three parts
1. **Marketing site** — `index.html` (single page). Summer/overnight camps still register
   through **RYZER** (external links) — leave those as-is unless asked.
2. **Clinic system** — self-hosted registration + payment + admin that replaces RYZER for
   clinics. Full details in **`README-CLINICS.md`**; go-live steps in **`CLINIC-SETUP.md`**.
3. **Shoot-a-Thon** — multi-level free-throw fundraiser (`donate.html`, `donate-pay.html`,
   `donate-success.html`, admin `shootathon.html`; API `pledge.js`/`shootathon.js`/`_shootathon.js`).
   Org→team→player goals that roll up. One-time donations charge NOW; per-made-throw pledges bill
   after (enter makes → send pay-links). Details in `README-CLINICS.md`.

## Gotchas
- **Payment provider is a switch**: `PAYMENT_PROVIDER=stripe|square`. Both adapters exist.
- **Session dates/prices live in four places that must stay in sync**: `api/_clinic.js`
  (authoritative), `register.html` (`SESSIONS`/`PRICE_*`, display), `clinics.html` (display),
  `admin.html` (`SESSION_LABELS`/`SESSION_DATES`). Fall 2026 dates are real and final.
- **Check-in**: `checkin.html` + `/api/checkin` use `CHECKIN_PASSWORD` (coach) or `ADMIN_PASSWORD`;
  attendance is stored on each registration as `attendance[sessionId][playerIndex]`.
- **Never trust browser prices** — the server recomputes via `expectedCents` in `api/_clinic.js`.
- **Registrations** are in Firestore; browsers never touch it directly (all via `/api`).
- **Shoot-a-Thon** reuses the same Stripe/webhook/Firestore/SendGrid/admin passcode. Three goal
  levels (org→team→player) that roll up; pledges carry `target_type` (org|team|player) + `target_slug`.
  Amount is authoritative in `api/_shootathon.js` (`computePledgeCents`); teams/players/goals/makes
  live in a `shootathon/{eventId}` Firestore doc (admin-edited, not code). One-time (flat) donations
  create a Stripe checkout at POST time; per-throw pledges are billed later via `donate-pay.html`
  pay-links that mint a fresh checkout at click-time (hosted sessions expire ~24h). **`firestore.rules`
  was extended for the `pledges` + `shootathon` collections — re-publish to Firebase or donation writes
  are permission-denied** (already published for fall-2026). Deductible receipts come from the booster
  club 501(c)(3), not the LLC (LLC only collects + remits).
- Run `npm test` for the offline suite (pricing, validation, auth gating; includes the shoot-a-thon).
- Preview without a backend: `admin.html?demo=1`, `shootathon.html?demo=1`, `donate.html?demo=1`.
