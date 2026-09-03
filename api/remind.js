// Vercel Serverless Function — /api/remind
// Day-before session reminders. Runs on a daily cron (see vercel.json). If TOMORROW
// (in Eastern time — sessions are Sundays at 11 AM ET) is a clinic session, it emails
// every PAID registrant who's signed up for that session a branded reminder.
// Idempotent: a reg gets `reminded_<sessionId>: true` once its reminder is sent, so
// a re-run (or a manual trigger) can never double-send. On non-session-eve days it's a no-op.
//
// Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>`; an admin may also
// trigger it with the x-admin-key header.
// Env: CRON_SECRET, ADMIN_PASSWORD, SENDGRID_API_KEY + MAIL_FROM, + Firestore vars.

import { fbConfigured, fbAdminConfigured, fsList, fsPatchVerified } from './_firestore.js';
import { SESSIONS, cleanSessions } from './_clinic.js';
import { sendMail, buildReminderEmail, emailConfigured } from './_email.js';
import { sessionStatus, isCanceled } from './_status.js';

// YYYY-MM-DD of the calendar day AFTER `now`, in Eastern time. We take today's ET date
// first, then add one day as a date-only value (in UTC) so DST changes can't skew it.
export function nextDayET(now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export function sessionOn(dateStr) {
  return SESSIONS.find((s) => s.date === dateStr) || null;
}

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

  const tomorrow = nextDayET();
  const session = sessionOn(tomorrow);
  if (!session) return res.status(200).json({ ok: true, tomorrow, session: null, sent: 0 });
  // A Sunday the admin cancelled (via /api/notify) must never get a "see you tomorrow" reminder.
  // If we can't READ the cancellation status, don't guess — a wrong reminder is worse than none.
  let status;
  try { status = await sessionStatus(); } catch (e) { return res.status(503).json({ ok: false, error: 'status_unavailable', tomorrow, session: session.id }); }
  if (isCanceled(status, session.id)) return res.status(200).json({ ok: true, tomorrow, session: session.id, sent: 0, skipped: 'session_canceled' });
  if (!emailConfigured()) return res.status(200).json({ ok: true, tomorrow, session: session.id, sent: 0, skipped: 'email_not_configured' });

  const flag = `reminded_${session.id}`;
  const all = await fsList('registrations');
  let sent = 0, already = 0, failed = 0;
  const targets = [];
  for (const reg of all) {
    if (String(reg.id || '').startsWith('_')) continue;          // internal docs (cron heartbeat, status)
    if (reg.status !== 'paid' || !reg.parent_email) continue;    // only real, paid registrations
    if (reg[flag]) { already++; continue; }                       // already reminded for this session
    const attends = !!reg.all_six || cleanSessions(reg.sessions).includes(session.id);
    if (attends) targets.push(reg);
  }
  // Send in small parallel batches so a few hundred families finish well inside the function's
  // time limit (see vercel.json maxDuration). The per-reg flag is written with a verified patch.
  for (let i = 0; i < targets.length; i += 8) {
    await Promise.all(targets.slice(i, i + 8).map(async (reg) => {
      const { subject, html } = buildReminderEmail(reg, session);
      const ok = await sendMail({ to: reg.parent_email, subject, html });
      if (ok) { await fsPatchVerified(`registrations/${reg.id}`, { [flag]: true }); sent++; }
      else failed++;
    }));
  }

  const result = { ok: true, tomorrow, session: session.id, sent, already, failed };
  console.log('remind', JSON.stringify(result));
  return res.status(200).json(result);
}
