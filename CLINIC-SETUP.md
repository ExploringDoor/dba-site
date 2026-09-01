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
- Turn on emailed receipts: Settings → Customer emails → enable "Successful payments."
- Env: `STRIPE_SECRET_KEY`

### If Square
- **developer.squareup.com** → your application → **Production** → copy the **Access token**
  and the **Location ID** for the location this money should land in.
- Env: `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_ENVIRONMENT` = `production`
  (use `sandbox` + sandbox keys first to test safely).

---

## 3. Confirmation emails (SendGrid) — optional but nice

The card **receipt** is sent automatically by Stripe/Square. SendGrid is only for our own
branded "You're registered!" email.

1. **sendgrid.com** → Settings → **API Keys** → Create → copy it.
2. Settings → **Sender Authentication** → verify a From address (e.g. `aceshoops@gmail.com`).
- Env: `SENDGRID_API_KEY`, `MAIL_FROM` = your verified address,
  `MAIL_FROM_NAME` = `Downer Basketball Academy` (optional),
  `ADMIN_EMAIL` = `aceshoops@gmail.com` (optional — you get a BCC of each confirmation).

---

## 4. Admin dashboard passcode

Pick any passcode you'll type to open `admin.html`.
- Env: `ADMIN_PASSWORD` = something long you'll remember

---

## 5. Optional

- `SITE_URL` = `https://www.downerbasketballacademy.com` (makes the after-payment redirect
  rock-solid; if you skip it we derive the address automatically).
- `CRON_SECRET` = any long random string. Powers the **reconcile safety net** — a job that
  runs every 15 min (configured in `vercel.json`) and finalizes any payment where the parent
  paid but closed the tab before the confirmation page loaded. Highly recommended so no paid
  registration is ever missed. (Set the same value in Vercel; Vercel sends it automatically.)

---

## 6. Finish

- [ ] Tell me the real **fall clinic dates** so I replace the placeholders.
- [ ] After pasting env vars, Vercel redeploys; open the site — the "opens soon" banner is gone.
- [ ] Do one **test registration** (Stripe/Square test mode) end to end.
- [ ] Open **/admin.html**, enter your passcode, confirm the test shows up, try a refund.
- [ ] Go live for real. 🏀

## Env var checklist (all in Vercel)
```
PAYMENT_PROVIDER          stripe | square
STRIPE_SECRET_KEY         (if Stripe)
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
SITE_URL                  (optional)
CRON_SECRET               (optional but recommended — powers the reconcile safety net)
```
