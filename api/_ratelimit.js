// Shared rate limiter for the public endpoints that send mail or write on a stranger's say-so
// (/api/pledge). Fixed window per key.
//
// Durable first: one small counter document per key in Firestore, written through the server
// login like everything else, so the count holds across serverless instances and cold starts.
//   ratelimits/<bucket>_<sha256(id) first 32 hex>   { start_ms, count, expires_ms }
// Keys are hashed, so no raw IP or email address is stored here. The collection needs its own
// admin-only rule in firestore.rules (browsers can never read or write it).
//
// If Firestore is not set up, the rule is not published yet, or the store errors, this falls
// back to a counter in warm-instance memory. Weaker, but a limiter outage never fails a real
// family's request.
//
//   const over = await firstBlocked([['pledge-ip', clientIp(req), 30, HOUR], ['pledge-email', emailKey(e), 12, DAY]]);
//   if (over) return res.status(429).json({ error: 'too_many' });

import { createHash } from 'node:crypto';
import { fbAdminConfigured, fsGetMeta, fsCreate, fsPatchVerified } from './_firestore.js';

const COLL = 'ratelimits';
export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// The caller's address as the platform saw it. Vercel sets x-real-ip (and overwrites
// x-forwarded-for) itself, so neither can be forged from outside; of a forwarded-for list, only the last entry
// (the one the platform added) is trusted. Empty when unknown.
export function clientIp(req) {
  const h = (req && req.headers) || {};
  const first = (v) => String(Array.isArray(v) ? v[0] : (v || '')).split(',')[0].trim();
  return (first(h['x-real-ip']) || first(h['x-vercel-forwarded-for']) || String(h['x-forwarded-for'] || '').split(',').pop().trim()).slice(0, 60);
}

// One key per mailbox: lower case, no "+tag", and no dots for Gmail, so name+1@ and n.a.m.e@
// cannot be used to get around the per-address cap on a single inbox.
export function emailKey(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at).split('+')[0];
  const domain = e.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replace(/\./g, '');
  return local + '@' + domain;
}

function keyFor(bucket, id) {
  return String(bucket).replace(/[^a-z0-9-]/gi, '') + '_' + createHash('sha256').update(String(id)).digest('hex').slice(0, 32);
}
const verdict = (count, limit, start, windowMs, now) => ({ ok: count <= limit, count, limit, retryAfterSec: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) });

// Warm-instance fallback.
const mem = new Map();
function memHit(key, limit, windowMs) {
  const now = Date.now();
  let m = mem.get(key);
  if (!m || now - m.start >= windowMs) m = { start: now, count: 0 };
  m.count++;
  if (mem.size > 5000) mem.clear();
  mem.set(key, m);
  return verdict(m.count, limit, m.start, windowMs, now);
}

// Read the counter, then write it back only if nobody else wrote in between (updateTime
// precondition), so a burst of parallel requests cannot all read the same count and slip through.
async function durableHit(key, limit, windowMs) {
  const path = `${COLL}/${key}`;
  for (let i = 0; i < 3; i++) {
    const now = Date.now();
    const m = await fsGetMeta(path);   // throws on anything except "not found"
    if (!m) {
      const c = await fsCreate(COLL, { start_ms: now, count: 1, expires_ms: now + windowMs }, key);
      if (c && c.name) return verdict(1, limit, now, windowMs, now);
      if (c && c.error && (c.error.code === 409 || c.error.status === 'ALREADY_EXISTS')) continue;   // lost the race to create it
      throw new Error('ratelimit_create_failed');
    }
    const live = !!m.doc.start_ms && now - m.doc.start_ms < windowMs;
    const start = live ? m.doc.start_ms : now;
    const count = (live ? (m.doc.count || 0) : 0) + 1;
    if (count > limit) return verdict(count, limit, start, windowMs, now);   // already over: nothing to write
    const w = await fsPatchVerified(path, { start_ms: start, count, expires_ms: start + windowMs }, 1, { ifUpdateTime: m.updateTime });
    if (w.ok) return verdict(count, limit, start, windowMs, now);
    if (w.status !== 400 && w.status !== 409 && w.status !== 412) throw new Error('ratelimit_write_failed');
    // someone else wrote first: read again
  }
  // Three lost races in a row on one key is a burst, not a person.
  return { ok: false, count: limit + 1, limit, retryAfterSec: 5 };
}

/** Count one hit against a key. Returns { ok, count, limit, retryAfterSec }. An empty id is never limited. */
export async function hit(bucket, id, limit, windowMs) {
  const who = String(id || '').trim().toLowerCase();
  if (!who) return { ok: true, count: 0, limit, retryAfterSec: 0 };
  const key = keyFor(bucket, who);
  if (fbAdminConfigured()) {
    try { return await durableHit(key, limit, windowMs); } catch (e) { /* fall through to memory */ }
  }
  return memHit(key, limit, windowMs);
}

/** Count one hit on each [bucket, id, limit, windowMs]; returns the first one that is over, or null. */
export async function firstBlocked(checks) {
  const out = await Promise.all(checks.map((c) => hit(c[0], c[1], c[2], c[3])));
  return out.find((r) => !r.ok) || null;
}
