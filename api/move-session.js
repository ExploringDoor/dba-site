// Vercel Serverless Function — /api/move-session  (admin only)
// POST { rid, from, to } — moves ONE Sunday on a PAID registration from `from` to `to`.
// Every single session is the same price, so a one-for-one swap never changes the amount owed —
// the player simply keeps their paid spot on a different date. Gated by ADMIN_PASSWORD.
//
// Refuses: a non-paid reg, an all-six reg (nothing to move), a `from` the family isn't booked for,
// a `to` they already hold, and a `to` Sunday the admin has cancelled.

import { fbConfigured, fbAdminConfigured, fsGet, fsPatchVerified } from './_firestore.js';
import { SESSION_IDS, cleanSessions } from './_clinic.js';
import { sessionStatus, isCanceled } from './_status.js';

function ctEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function authed(req) {
  const want = process.env.ADMIN_PASSWORD || '';
  return !!want && ctEq(req.headers['x-admin-key'] || '', want); // header only — never a URL query param
}
function safeId(id) { return /^[A-Za-z0-9_-]{1,128}$/.test(String(id || '')); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: 'admin_not_configured' });
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!fbConfigured() || !fbAdminConfigured()) return res.status(503).json({ error: 'db_not_configured' });

  const b = req.body || {};
  const from = String(b.from || ''), to = String(b.to || '');
  if (!safeId(b.rid)) return res.status(400).json({ error: 'bad_rid' });
  if (!SESSION_IDS.includes(from) || !SESSION_IDS.includes(to)) return res.status(400).json({ error: 'bad_session' });
  if (from === to) return res.status(400).json({ error: 'same_session' });

  const reg = await fsGet(`registrations/${b.rid}`);
  if (!reg) return res.status(404).json({ error: 'not_found' });
  if (reg.status !== 'paid') return res.status(400).json({ error: 'not_paid' });   // only move a paid spot
  if (reg.all_six) return res.status(400).json({ error: 'all_six' });              // already has every Sunday

  const current = cleanSessions(reg.sessions);
  if (!current.includes(from)) return res.status(400).json({ error: 'not_booked_from' });
  if (current.includes(to)) return res.status(400).json({ error: 'already_booked_to' });

  // Never move someone onto a Sunday the admin has cancelled.
  const st = await sessionStatus();
  if (isCanceled(st, to)) return res.status(400).json({ error: 'target_canceled' });

  // Swap the session, keeping the list in canonical (chronological) order.
  const next = SESSION_IDS.filter((s) => s === to || (current.includes(s) && s !== from));

  // Carry any recorded check-in off the old Sunday (normally empty — you move a FUTURE date).
  const attendance = Object.assign({}, reg.attendance || {});
  if (attendance[from]) {
    attendance[to] = Object.assign({}, attendance[to] || {}, attendance[from]);
    delete attendance[from];
  }

  const w = await fsPatchVerified(`registrations/${b.rid}`, {
    sessions: next,
    attendance,
    moved_at: new Date().toISOString(),
    moved_from: from,
    moved_to: to,
  });
  if (!w.ok) return res.status(502).json({ error: 'update_failed' });
  return res.status(200).json({ ok: true, sessions: next, from, to });
}
