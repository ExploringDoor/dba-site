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
import { verifyPayment, finalizePaid } from './_finalize.js';

const PENDING_GRACE_MS = 2 * 60 * 1000;        // don't touch anything younger than 2 min (still checking out)
const ABANDON_AFTER_MS = 2 * 24 * 60 * 60 * 1000; // give up after 2 days unpaid

function authed(req) {
  const cron = process.env.CRON_SECRET;
  const auth = req.headers['authorization'] || '';
  if (cron && auth === `Bearer ${cron}`) return true;
  const admin = process.env.ADMIN_PASSWORD;
  return !!admin && (req.headers['x-admin-key'] || '') === admin;
}

export default async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!fbConfigured() || !fbAdminConfigured()) return res.status(503).json({ error: 'db_not_configured' });

  const now = Date.now();
  const all = await fsList('registrations');
  const pending = all.filter((r) => r.status === 'pending');

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

  const result = { ok: true, pending: pending.length, checked, finalized, abandoned, inconclusive };
  // Heartbeat the admin dashboard can see. Lives under the (admin-writable) registrations
  // collection as a reserved `_`-prefixed doc; /api/registrations filters it out of the list.
  try { await fsPatch('registrations/_cron_reconcile', { last_run: new Date().toISOString(), ...result }); } catch (e) { /* never fail the cron on a heartbeat */ }
  console.log('reconcile', JSON.stringify(result)); // heartbeat — if this never logs, the cron isn't running
  return res.status(200).json(result);
}
