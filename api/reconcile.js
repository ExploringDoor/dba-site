// Vercel Serverless Function — /api/reconcile
// Safety net for payments where the parent paid but never returned to the success
// page (closed the tab, lost signal). Runs on a cron (see vercel.json) and can also
// be triggered manually by an admin. For each still-"pending" registration it asks
// the provider whether the payment actually completed, and finalizes it if so.
// Very old pending rows (never paid) are marked "abandoned" so the dashboard stays clean.
//
// Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. An admin may also
// call it with the x-admin-key header.
// Env: CRON_SECRET (for the cron), ADMIN_PASSWORD (for manual), + Firestore/provider vars.

import { fbConfigured, fbAdminConfigured, fsList, fsPatch, fsPatchVerified } from './_firestore.js';
import { verifyPayment, finalizePaid, maybeSendConfirmation } from './_finalize.js';

const PENDING_GRACE_MS = 2 * 60 * 1000;        // don't touch anything younger than 2 min (still checking out)
const ABANDON_AFTER_MS = 2 * 24 * 60 * 60 * 1000; // give up after 2 days unpaid
const MAX_PENDING_PER_RUN = 60;                 // bound the work per run (a spam flood can't make the cron time out) — oldest first, rest next run
const EMAIL_RETRY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EMAIL_RETRIES_PER_RUN = 20;

function ctEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function authed(req) {
  const cron = process.env.CRON_SECRET || '';
  if (cron && ctEq(req.headers['authorization'] || '', `Bearer ${cron}`)) return true;
  const admin = process.env.ADMIN_PASSWORD || '';
  return !!admin && ctEq(req.headers['x-admin-key'] || '', admin);
}

export default async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!fbConfigured() || !fbAdminConfigured()) return res.status(503).json({ error: 'db_not_configured' });

  const now = Date.now();
  // fsList THROWS if Firestore can't be read (→ 500, no heartbeat) — a failed read must never
  // paint the dashboard's green "safety-net running" light.
  const all = await fsList('registrations');
  const allPending = all.filter((r) => r.status === 'pending').sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')));
  const pending = allPending.slice(0, MAX_PENDING_PER_RUN);

  let finalized = 0, abandoned = 0, checked = 0, inconclusive = 0;
  for (const reg of pending) {
    const age = now - new Date(reg.created || 0).getTime();
    if (!(age > PENDING_GRACE_MS)) continue; // too fresh — parent may still be checking out
    checked++;
    let v;
    try {
      v = await verifyPayment(reg);
    } catch (e) {
      inconclusive++; continue; // provider hiccup — try again next run, NEVER abandon
    }
    if (v.paid) { await finalizePaid(reg.id, reg, v.patch); finalized++; continue; }
    if (!v.determinate) { inconclusive++; continue; } // couldn't tell (outage) — never abandon
    // Only here is the payment AFFIRMATIVELY not completed. Give up once it's old.
    if (age > ABANDON_AFTER_MS) {
      await fsPatchVerified(`registrations/${reg.id}`, { status: 'abandoned', abandoned_at: new Date().toISOString() });
      abandoned++;
    }
  }

  // Second pass: PAID registrations whose receipt email never went out (SendGrid blip at payment
  // time released the claim) — retry, bounded, for up to 30 days. maybeSendConfirmation's
  // claim-before-send keeps this from ever double-sending.
  let emailed = 0;
  const unmailed = all.filter((r) => r.status === 'paid' && !r.confirm_email_sent && r.parent_email
    && (now - new Date(r.paid_at || r.created || 0).getTime()) < EMAIL_RETRY_WINDOW_MS).slice(0, MAX_EMAIL_RETRIES_PER_RUN);
  for (const reg of unmailed) {
    try { if (await maybeSendConfirmation(reg.id, reg)) emailed++; } catch (e) { /* next run */ }
  }

  const result = { ok: true, pending: allPending.length, checked, finalized, abandoned, inconclusive, emailed, deferred: Math.max(0, allPending.length - pending.length) };
  // Heartbeat the admin dashboard can see. Lives under the (admin-writable) registrations
  // collection as a reserved `_`-prefixed doc; /api/registrations filters it out of the list.
  try { await fsPatch('registrations/_cron_reconcile', { last_run: new Date().toISOString(), ...result }); } catch (e) { /* never fail the cron on a heartbeat */ }
  console.log('reconcile', JSON.stringify(result)); // heartbeat — if this never logs, the cron isn't running
  return res.status(200).json(result);
}
