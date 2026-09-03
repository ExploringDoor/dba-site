// Test-only environment for the offline flow suite. Every value is FAKE.
//
// Several api modules read env at import time (api/_firestore.js, api/_email.js,
// api/checkout.js), so this file must be evaluated before any of them — tests/_fake.js
// imports it first, and tests/flows.test.mjs imports tests/_fake.js before any api module.
//
// Values are set UNCONDITIONALLY so a developer's shell (or a stray .env) can never
// point this suite at real Firebase / Stripe / SendGrid. The fake fetch in _fake.js
// refuses any host it doesn't know, so nothing can leave the process anyway.

export const ENV = {
  FIREBASE_PROJECT_ID: 'dba-test-project',
  FIREBASE_API_KEY: 'AIza-fake-web-key',
  FB_ADMIN_EMAIL: 'server-admin@test.local',
  FB_ADMIN_PASSWORD: 'fb-admin-pass',
  PAYMENT_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_fake',
  SENDGRID_API_KEY: 'SG.fake',
  MAIL_FROM: 'noreply@test.local',
  MAIL_FROM_NAME: 'DBA Test',
  ADMIN_EMAIL: 'admin@test.local',
  ADMIN_PASSWORD: 'admin-pass',
  CHECKIN_PASSWORD: 'coach-pass',
  CRON_SECRET: 'cron-secret',
  SITE_URL: 'https://dba.test',
};
for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
// Never let Square creds leak in from the shell — the suite is Stripe-only.
for (const k of ['SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID', 'SQUARE_ENVIRONMENT', 'MAIL_REPLY_TO']) delete process.env[k];
