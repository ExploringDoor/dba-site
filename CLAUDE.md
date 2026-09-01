# Downer Basketball Academy — site notes

Static site → GitHub (`ExploringDoor/dba-site`) → Vercel auto-deploy. The owner (Adam)
is **non-technical** and works in the Claude Code desktop app — guide via the app, not
the terminal, and don't push to git or change accounts without being asked.

## Two parts
1. **Marketing site** — `index.html` (single page). Summer/overnight camps still register
   through **RYZER** (external links) — leave those as-is unless asked.
2. **Clinic system** — self-hosted registration + payment + admin that replaces RYZER for
   clinics. Full details in **`README-CLINICS.md`**; go-live steps in **`CLINIC-SETUP.md`**.

## Gotchas
- **Payment provider is a switch**: `PAYMENT_PROVIDER=stripe|square`. Both adapters exist.
- **Session dates/prices live in three places that must stay in sync**: `api/_clinic.js`
  (authoritative), `register.html` (`SESSIONS`/`PRICE_*`, display), `clinics.html` (display).
  Fall dates are still placeholders — marked with the dashed-pink `.tbd` style.
- **Never trust browser prices** — the server recomputes via `expectedCents` in `api/_clinic.js`.
- **Registrations** are in Firestore; browsers never touch it directly (all via `/api`).
- Run `npm test` for the offline suite (pricing, validation, auth gating).
- Preview the admin dashboard without a backend: `admin.html?demo=1`.
