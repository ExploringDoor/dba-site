// Vercel Serverless Function — /api/notify (admin only)
// Email every family registered for ONE Sunday — a cancellation (weather / gym closure) or a
// general notice. For a cancellation it also flags the session (registrations/_sessions) so
// the date disappears from the registration form, /api/checkout refuses it, the day-before
// reminder is skipped, and check-in shows it as cancelled.
//
//   GET  /api/notify?session=s2                        → { families, players, canceled, canceled_at, email_ready }
//   POST { session, subject, message, cancel:true }    → flag + email everyone   → { sent, failed, families }
//   POST { session, subject, message }                 → email everyone (no flag)
//   POST { session, reopen:true }                      → clear the cancelled flag (no email)
//
// One SendGrid call per 500 families (sendBulk), so a whole roster goes out in a second.

import { fbConfigured, fbAdminConfigured, fsList, fsCreate } from './_firestore.js';
import { SESSIONS, SESSION_IDS, cleanSessions } from './_clinic.js';
import { sendBulk, buildNoticeEmail, emailConfigured, ADMIN_EMAIL } from './_email.js';
import { sessionStatus, setSessionStatus, isCanceled } from './_status.js';

function ctEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function authed(req) { const a = process.env.ADMIN_PASSWORD || ''; return !!a && ctEq(req.headers['x-admin-key'] || '', a); }
const attends = (r, sid) => !!r.all_six || cleanSessions(r.sessions).includes(sid);
const shortLabel = (s) => s.label.replace(/^Session \d+ — /, '');

// Paid families registered for this Sunday, one entry per parent email (siblings share one email).
async function families(sid) {
  const all = await fsList('registrations');
  const byEmail = new Map();
  let players = 0;
  for (const r of all) {
    if (String(r.id || '').startsWith('_') || r.status !== 'paid' || !attends(r, sid)) continue;
    players += (r.players || []).length;
    const email = String(r.parent_email || '').trim().toLowerCase();
    if (!email || byEmail.has(email)) continue;
    byEmail.set(email, { email, name: String(r.parent_name || '').trim().split(/\s+/)[0] || 'there' });
  }
  return { recipients: [...byEmail.values()], players };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: 'admin_not_configured' });
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });

  const src = req.method === 'GET' ? (req.query || {}) : (req.body || {});
  const sid = String(src.session || '');
  if (!SESSION_IDS.includes(sid)) return res.status(400).json({ error: 'bad_session' });
  const session = SESSIONS.find((s) => s.id === sid);
  const reopen = req.method === 'POST' && !!src.reopen;
  const message = String(src.message || '').trim();
  if (req.method === 'POST' && !reopen && (!message || message.length > 4000)) return res.status(400).json({ error: 'bad_message' });
  if (!fbConfigured() || !fbAdminConfigured()) return res.status(503).json({ error: 'db_not_configured' });

  const status = await sessionStatus();
  const now = new Date().toISOString();

  if (req.method === 'GET') {
    const f = await families(sid);
    return res.status(200).json({
      ok: true, session: { id: sid, label: shortLabel(session), date: session.date },
      families: f.recipients.length, players: f.players,
      canceled: isCanceled(status, sid), canceled_at: (status[sid] && status[sid].canceled_at) || '',
      email_ready: emailConfigured(),
    });
  }

  if (reopen) {
    const w = await setSessionStatus(sid, { canceled: false, reopened_at: now });
    if (!w.ok) return res.status(502).json({ error: 'status_write_failed' });
    return res.status(200).json({ ok: true, session: sid, canceled: false });
  }

  const cancel = !!src.cancel;
  const subject = String(src.subject || '').trim().slice(0, 200);
  // Flag FIRST — even if the emails fail, the date stops selling and the reminder stops.
  if (cancel) {
    const w = await setSessionStatus(sid, { canceled: true, canceled_at: now, subject });
    if (!w.ok) return res.status(502).json({ error: 'status_write_failed' });
  }
  if (!emailConfigured()) return res.status(503).json({ error: 'email_not_configured', canceled: cancel });

  const f = await families(sid);
  const mail = buildNoticeEmail(session, { subject, message, cancel });
  const out = await sendBulk({ recipients: f.recipients, subject: mail.subject, html: mail.html, text: mail.text, bcc: ADMIN_EMAIL });
  try {
    await fsCreate('notices', { session: sid, subject: mail.subject, message, cancel, families: f.recipients.length, players: f.players, sent: out.sent, failed: out.failed, error: out.error || '', at: now });
  } catch (e) { /* the log is best-effort */ }
  return res.status(200).json({ ok: true, session: sid, families: f.recipients.length, players: f.players, sent: out.sent, failed: out.failed, error: out.error || '', canceled: cancel || isCanceled(status, sid) });
}
