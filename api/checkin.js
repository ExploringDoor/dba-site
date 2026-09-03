// Vercel Serverless Function — /api/checkin
// Clinic-day check-in. Powers checkin.html (a stripped-down, phone-friendly page for
// coaches/managers) and the tap-to-check-in buttons inside admin.html.
//
//   GET  /api/checkin                 → { sessions:[{id,label,date}] }
//   GET  /api/checkin?session=s1      → that session's roster: PAID attendees only, with ONLY
//                                       door-side fields — player, parent / emergency / pickup
//                                       names + phones, medical notes, checked-in state.
//                                       Never emails, payment amounts, or waivers.
//   POST /api/checkin { rid, session, player, present }  → records / clears a check-in
//
// Auth: x-checkin-key (or x-admin-key) matching CHECKIN_PASSWORD *or* ADMIN_PASSWORD — so the
// full admin passcode also works here, while a coach's check-in passcode works ONLY here.
// Attendance lives on the registration as attendance[sessionId][playerIndex] = ISO timestamp.

import { fbConfigured, fbAdminConfigured, fsGet, fsList, fsPatchVerified } from './_firestore.js';
import { SESSIONS, SESSION_IDS, cleanSessions } from './_clinic.js';

function ctEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function authed(req) {
  const key = req.headers['x-checkin-key'] || req.headers['x-admin-key'] || '';
  const coach = process.env.CHECKIN_PASSWORD || '', admin = process.env.ADMIN_PASSWORD || '';
  return (!!coach && ctEq(key, coach)) || (!!admin && ctEq(key, admin));
}
function safeId(id) { return /^[A-Za-z0-9_-]{1,128}$/.test(String(id || '')); }
function real(v) { v = String(v || '').trim(); return v && !/^(none|n\/?a|no|no\.|nope|n)$/i.test(v) ? v : ''; }
function medicalSummary(r) {
  const p = [];
  if (real(r.allergies)) p.push('Allergies: ' + real(r.allergies));
  if (real(r.medications)) p.push('Meds: ' + real(r.medications));
  if (real(r.medical_conditions)) p.push('Conditions: ' + real(r.medical_conditions));
  return p.join(' · ');
}
function attends(reg, sid) { return !!reg.all_six || cleanSessions(reg.sessions).includes(sid); }
const shortLabel = (s) => s.label.replace(/^Session \d+ — /, '');

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.CHECKIN_PASSWORD && !process.env.ADMIN_PASSWORD) return res.status(503).json({ error: 'checkin_not_configured' });
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });

  if (req.method === 'GET') {
    const sid = String((req.query && req.query.session) || '');
    if (!sid) return res.status(200).json({ ok: true, sessions: SESSIONS.map((s) => ({ id: s.id, label: shortLabel(s), date: s.date })) });
    if (!SESSION_IDS.includes(sid)) return res.status(400).json({ error: 'bad_session' });
    if (!fbConfigured() || !fbAdminConfigured()) return res.status(503).json({ error: 'db_not_configured' });

    const all = await fsList('registrations');
    const players = [];
    for (const r of all) {
      if (String(r.id || '').startsWith('_') || r.status !== 'paid' || !attends(r, sid)) continue;
      const att = (r.attendance && r.attendance[sid]) || {};
      (r.players || []).forEach((p, i) => {
        players.push({
          rid: r.id, pi: i, first: p.first || '', last: p.last || '',
          parent_name: r.parent_name || '', parent_phone: r.parent_phone || '',
          emerg_name: r.emerg_name || '', emerg_phone: r.emerg_phone || '',
          pickup_name: r.pickup_name || '', pickup_phone: r.pickup_phone || '',
          medical: medicalSummary(r),
          present: !!att[String(i)], present_at: att[String(i)] || '',
        });
      });
    }
    players.sort((a, b) => (a.last + ' ' + a.first).localeCompare(b.last + ' ' + b.first));
    const s = SESSIONS.find((x) => x.id === sid);
    return res.status(200).json({
      ok: true,
      session: { id: sid, label: shortLabel(s), date: s.date },
      counts: { total: players.length, present: players.filter((p) => p.present).length },
      players,
    });
  }

  // POST — record or clear one player's check-in for one session (validate before any DB call)
  const b = req.body || {};
  const sid = String(b.session || '');
  const pi = Number(b.player);
  const present = !!b.present;
  if (!safeId(b.rid)) return res.status(400).json({ error: 'bad_rid' });
  if (!SESSION_IDS.includes(sid)) return res.status(400).json({ error: 'bad_session' });
  if (!Number.isInteger(pi) || pi < 0 || pi > 20) return res.status(400).json({ error: 'bad_player' });
  if (!fbConfigured() || !fbAdminConfigured()) return res.status(503).json({ error: 'db_not_configured' });

  const reg = await fsGet(`registrations/${b.rid}`);
  if (!reg) return res.status(404).json({ error: 'not_found' });
  if (reg.status !== 'paid' || !attends(reg, sid) || pi >= (reg.players || []).length) return res.status(400).json({ error: 'not_on_roster' });

  // Read-modify-write the whole attendance map so other sessions' check-ins are preserved.
  const attendance = Object.assign({}, reg.attendance || {});
  const day = Object.assign({}, attendance[sid] || {});
  const now = new Date().toISOString();
  if (present) day[String(pi)] = now; else delete day[String(pi)];
  attendance[sid] = day;
  const w = await fsPatchVerified(`registrations/${b.rid}`, { attendance });
  if (!w.ok) return res.status(502).json({ error: 'write_failed' });
  return res.status(200).json({ ok: true, rid: b.rid, session: sid, player: pi, present, present_at: present ? now : '' });
}
