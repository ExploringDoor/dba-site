# Fall Clinics — Go-Live Setup

Everything is built. To switch the registration + payment + admin system ON, you'll
create a few free accounts and paste some keys into **Vercel → your project → Settings
→ Environment Variables**. You never send me any of these keys — you paste them yourself.

Work top to bottom. When all boxes are checked, checkout goes live automatically and the
"Registration opens soon" banner disappears.

---

## 1. Database (Firebase / Firestore) — stores who signed up

1. Go to **console.firebase.google.com** → **Add project** → name it e.g. `dba-clinics`.
2. In the project: **Build → Firestore Database → Create database** → Production mode → pick a US region.
3. **Build → Authentication → Get started → Email/Password → Enable.**
4. **Authentication → Users → Add user.** Make one login just for the server, e.g.
   `server@downerbasketballacademy.com` + a long password. Copy its **User UID**.
5. In **Firestore → Start collection** named `admins`. Add a document whose **ID = that User UID**,
   with fields: `role` = `super` (string), `active` = `true` (boolean).
6. Project settings (gear icon) → **General** → scroll to "Your apps" → Web app → copy the
   **Project ID** and the **Web API Key**.
7. Deploy the security rules in `firestore.rules` (I'll help — one command, or paste them in the
   Firestore **Rules** tab and Publish).

**Vercel env vars from this step:**
- `FIREBASE_PROJECT_ID` = your project id
- `FIREBASE_API_KEY` = your web API key
- `FB_ADMIN_EMAIL` = the server login email
- `FB_ADMIN_PASSWORD` = the server login password

---

## 2. Payments — pick ONE and set the switch

Set `PAYMENT_PROVIDER` to `stripe` **or** `square`, then fill that one's keys.

### If Stripe
- **dashboard.stripe.com** → Developers → API keys → copy the **Secret key** (`sk_live_...`).
- Env: `STRIPE_SECRET_KEY`
- **Webhook (required):** Developers → Webhooks → Add destination → URL
  `https://www.greggdownerbasketball.com/api/webhook-stripe`, event `checkout.session.completed`.
  Copy its **Signing secret** (`whsec_...`) → Env: `STRIPE_WEBHOOK_SECRET`. This is what marks a
  registration paid the instant Stripe confirms it, even if the parent closes the tab.
- Stripe's own customer emails are left OFF — our branded confirmation email is the receipt.

### If Square
- **developer.squareup.com** → your application → **Production** → copy the **Access token**
  and the **Location ID** for the location this money should land in.
- Env: `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_ENVIRONMENT` = `production`
  (use `sandbox` + sandbox keys first to test safely).

---

## 3. Confirmation emails (SendGrid) — optional but nice

SendGrid sends our branded "You're registered!" receipt, the refund receipt, and the
day-before reminder. (Stripe's own customer emails are left off — ours is the receipt.)

1. **sendgrid.com** → Settings → **API Keys** → Create → copy it.
2. Settings → **Sender Authentication** → **Authenticate Your Domain** (`greggdownerbasketball.com`;
   add the records it gives you in Cloudflare as **DNS only**, not proxied). Don't send from a
   gmail.com address — it fails DMARC and lands in spam.
- Env: `SENDGRID_API_KEY`, `MAIL_FROM` = `noreply@greggdownerbasketball.com`,
  `MAIL_FROM_NAME` = `Downer Basketball Academy` (optional),
  `ADMIN_EMAIL` = `aceshoops@gmail.com` (optional — you get a BCC of each confirmation),
  `MAIL_REPLY_TO` = where parent replies go (optional; defaults to `aceshoops@gmail.com`).

---

## 4. Admin dashboard passcode

Pick any passcode you'll type to open `admin.html`.
- Env: `ADMIN_PASSWORD` = something long you'll remember
- Env: `CHECKIN_PASSWORD` = a *different*, simpler passcode for coaches/managers. It opens
  **only** `checkin.html` (clinic-day attendance: roster, parent phones, medical notes,
  tap-to-check-in) — never the full admin, payments, or emails. Your admin passcode works
  there too, so this is optional until you hand check-in duty to someone else.

---

## 5. Optional

- `SITE_URL` = `https://www.greggdownerbasketball.com` (makes the after-payment redirect
  rock-solid; if you skip it we derive the address automatically).
- `CRON_SECRET` = any long random string — **required** (it also unlocks the nightly
  reminder-email cron). Powers the **reconcile safety net** — a job that
  runs every 15 min (configured in `vercel.json`) and finalizes any payment where the parent
  paid but closed the tab before the confirmation page loaded. Highly recommended so no paid
  registration is ever missed. (Set the same value in Vercel; Vercel sends it automatically.)

---

## 5b. Before go-live: extra hardening (recommended)

- **Set `SITE_URL`** (section 5) in production — the post-payment redirect then can't be
  influenced by a spoofed `Host` header.
- **Watch for spam once payments are on.** `/api/checkout` is public (it has to be) and has a
  hidden-field honeypot plus a duplicate-paid guard, but no rate limit of its own. Note: DNS is
  on Cloudflare but the site is served straight from Vercel (not proxied), so Cloudflare
  rate-limit/Turnstile rules do NOT apply — use **Vercel → Firewall → Rate limiting** on
  `POST /api/checkout` (Pro plan) if bot signups ever appear.

## 6. Finish

- [ ] After pasting env vars, Vercel redeploys; open the site — the "opens soon" banner is gone.
- [ ] Do one **test registration** (Stripe/Square test mode) end to end.
- [ ] Open **/admin.html**, enter your passcode, confirm the test shows up, try a refund.
- [ ] Go live for real. 🏀

## 7. Shoot-a-Thon (donations) — optional, reuses everything above

A per-made-shot fundraiser: supporters **pledge** now (no card), then after the event you
enter each player's made-shot count and the system emails everyone a secure pay-link for
their total. Supporters can back a specific player (per made shot, with an optional cap) or
give a flat one-time gift. Money routes exactly like clinics — collected by Always Competing
Sports LLC and remitted to the booster club, which issues the tax-deductible receipt.

**Good news: no new accounts.** It reuses the same Firebase, the same Stripe (and the **same
Stripe webhook** — nothing to add there), the same SendGrid, and the same admin passcode.

- [ ] **Re-publish the database security rules.** I added two collections (`pledges`,
      `shootathon`) to `firestore.rules`. Until the rules are re-published, pledges can't be
      saved. Firebase console → **Firestore → Rules** tab → paste the contents of
      `firestore.rules` → **Publish** (or `firebase deploy --only firestore:rules`). *This is
      the one required step — everything else below is done from the admin page.*
- [ ] *(Optional)* Set the booster club's exact name + EIN so donation receipts name the
      right 501(c)(3): `BOOSTER_NAME` = e.g. `Lower Merion Basketball Boosters`,
      `BOOSTER_EIN` = e.g. `12-3456789`. If you skip these, receipts say "the organizing
      booster club" (still accurate), with no EIN line.
- [ ] Open **/shootathon.html**, sign in with your **admin passcode**. Under **Event setup**:
      name it, set a goal, add your players, check **Open for pledges**, **Save**.
- [ ] Share the links: the **public donate page** is `/donate.html`, and each player has their
      own shareable link (Copy buttons are right there on the admin page).
- [ ] **After the event:** enter each player's **made shots** → **Save** → **Send pay-links**.
      Supporters get an email with their exact total and a secure "Donate" button. Use
      **Sync payments** anytime to double-check anything that didn't confirm automatically.

Preview it with no backend: **/shootathon.html?demo=1** and **/donate.html?demo=1**.

**Important — deductible donations must land with the 501(c)(3).** This system collects
through your LLC's Stripe (same as clinics) and remits to the booster club, and the receipts
say the booster club provides the official acknowledgment. Confirm with the booster club that
they'll issue the year-end tax acknowledgments (and that they're comfortable with this
collect-and-remit arrangement) before you promote it as tax-deductible.

---

## Env var checklist (all in Vercel)
```
PAYMENT_PROVIDER          stripe | square
STRIPE_SECRET_KEY         (if Stripe)
STRIPE_WEBHOOK_SECRET     (if Stripe — required)
SQUARE_ACCESS_TOKEN       (if Square)
SQUARE_LOCATION_ID        (if Square)
SQUARE_ENVIRONMENT        production | sandbox   (if Square)
FIREBASE_PROJECT_ID
FIREBASE_API_KEY
FB_ADMIN_EMAIL
FB_ADMIN_PASSWORD
SENDGRID_API_KEY          (optional)
MAIL_FROM                 (optional)
MAIL_FROM_NAME            (optional)
ADMIN_EMAIL               (optional)
ADMIN_PASSWORD
CHECKIN_PASSWORD          (optional — coach check-in page only)
SITE_URL                  (optional)
CRON_SECRET               (required — powers the payment safety net + reminder emails)
BOOSTER_NAME              (optional — Shoot-a-Thon receipts name the 501(c)(3))
BOOSTER_EIN               (optional — Shoot-a-Thon receipts show the EIN)
SHOOTATHON_EVENT_ID       (optional — defaults to fall-2026)
```
