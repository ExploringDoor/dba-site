// Per-session status — e.g. a Sunday cancelled for weather or a gym closure.
// Lives in ONE reserved doc: registrations/_sessions →
//   { s2: { canceled: true, canceled_at: ISO, subject: '…' }, s5: { canceled: false, reopened_at: ISO } }
// Read by: /api/checkout (hide + refuse cancelled dates), /api/remind (skip the reminder),
// /api/checkin (label the chip), /api/registrations (admin badge). Written by /api/notify.

import { fbConfigured, fbAdminConfigured, fsGet, fsPatchVerified } from './_firestore.js';

export const STATUS_DOC = 'registrations/_sessions';

export async function sessionStatus() {
  if (!fbConfigured() || !fbAdminConfigured()) return {};
  try {
    const d = await fsGet(STATUS_DOC);
    if (!d) return {};
    const { id, ...rest } = d;
    return rest;
  } catch (e) { return {}; }
}
export function isCanceled(status, sid) { return !!(status && status[sid] && status[sid].canceled); }
export function canceledIds(status) { return Object.keys(status || {}).filter((k) => isCanceled(status, k)); }

// Merge `info` into one session's entry (read-modify-write; the doc is created on first use).
export async function setSessionStatus(sid, info) {
  const cur = await sessionStatus();
  const next = Object.assign({}, cur[sid] || {}, info);
  return fsPatchVerified(STATUS_DOC, { [sid]: next });
}
