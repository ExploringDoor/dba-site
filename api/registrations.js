// Vercel Serverless Function — /api/registrations
// Admin-only: lists every clinic registration for the dashboard (admin.html).
// Gated by a shared admin key (ADMIN_PASSWORD), sent as ?key= or the
// x-admin-key header. Reads Firestore with the privileged admin token.
//
// Env: ADMIN_PASSWORD (+ FIREBASE_* / FB_ADMIN_* for Firestore).

import { fbConfigured, fbAdminConfigured, fsList } from './_firestore.js';
import { cleanSessions } from './_clinic.js';

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: 'admin_not_configured' });
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!fbConfigured() || !fbAdminConfigured()) return res.status(503).json({ error: 'db_not_configured' });

  const raw = await fsList('registrations');
  // Reserved `_`-prefixed docs are internal (the reconcile cron's heartbeat) — never list them.
  const cronDoc = raw.find((r) => r.id === '_cron_reconcile') || null;
  const all = raw.filter((r) => !String(r.id || '').startsWith('_'));
  // newest first
  all.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));

  // Roll-up the admin cares about.
  const paid = all.filter((r) => r.status === 'paid');
  const collectedCents = paid.reduce((s, r) => s + ((r.amount_cents || 0) - (r.amount_refunded_cents || 0)), 0);
  const players = paid.reduce((s, r) => s + (r.player_count || 0), 0);
  const perSession = {};
  paid.forEach((r) => cleanSessions(r.sessions).forEach((sid) => { perSession[sid] = (perSession[sid] || 0) + (r.player_count || 0); }));

  return res.status(200).json({
    ok: true,
    count: all.length,
    summary: {
      paid: paid.length,
      pending: all.filter((r) => r.status === 'pending').length,
      canceled: all.filter((r) => r.status === 'canceled').length,
      refunded: all.filter((r) => r.status === 'refunded').length,
      abandoned: all.filter((r) => r.status === 'abandoned').length,
      errored: all.filter((r) => r.status === 'error').length,
      mismatched: all.filter((r) => r.amount_mismatch).length,
      players,
      collected: (collectedCents / 100).toFixed(2),
      perSession,
    },
    cron: cronDoc ? { last_run: cronDoc.last_run || '', pending: cronDoc.pending || 0, finalized: cronDoc.finalized || 0, abandoned: cronDoc.abandoned || 0 } : null,
    registrations: all,
  });
}
