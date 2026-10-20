// ─────────────────────────────────────────────────────────────────────────
// Downer Basketball Academy — Shoot-a-Thon (per-made-shot fundraiser).
// Config, validation, and the AUTHORITATIVE amount computation.
//
// Model (locked with Adam): supporters PLEDGE now with NO card on file. After the
// event the admin enters each player's made-shot count and sends a one-time secure
// pay-link for the exact total. A supporter either backs a specific player (a pledge
// PER MADE SHOT, with an optional cap) or gives a flat one-time gift.
//
// Money routing mirrors the clinics: payments are collected by Always Competing
// Sports LLC on behalf of the organizing booster club (a 501(c)(3)) and remitted in
// full — the booster club issues the official tax-deductible acknowledgment.
//
// Like _clinic.js, THIS FILE is the server-side source of truth for money bounds.
// The browser sends what the supporter picked; the server clamps / recomputes here so
// a tampered request can never create an out-of-range charge, and the final charge is
// always recomputed from the stored pledge + the admin-entered makes — never trusted
// from a browser.
// ─────────────────────────────────────────────────────────────────────────

import { clip, stripTags, validEmail } from './_clinic.js';

export const SHOOTATHON = {
  // Firestore config doc lives at shootathon/<eventId>; pledges carry event_id so a
  // future year reuses the same code with a new id.
  eventId: process.env.SHOOTATHON_EVENT_ID || 'fall-2026',
  title: 'Aces Shoot-a-Thon',
  // The organizing booster club actually receives the funds and issues tax receipts.
  // Kept generic by default (matches the clinic wording); set BOOSTER_NAME / BOOSTER_EIN
  // in Vercel to print the exact legal name + EIN on donation receipts — no code change.
  boosterName: process.env.BOOSTER_NAME || "the clinic's organizing booster club",
  boosterEin: process.env.BOOSTER_EIN || '',
};

// Authoritative money bounds. A pledge outside these is rejected at intake; the final
// computed charge is also hard-clamped to maxChargeCents as a last line of defense.
export const LIMITS = {
  minPerShotCents: 25,       // $0.25 per made shot
  maxPerShotCents: 2500,     // $25.00 per made shot (sanity ceiling)
  maxCapCents: 500000,       // $5,000 cap ceiling
  minFlatCents: 500,         // $5 minimum one-time gift
  maxFlatCents: 1000000,     // $10,000 maximum one-time gift
  maxMakes: 300,             // a player can be credited at most 300 makes (bounds per-shot totals)
  maxChargeCents: 1000000,   // $10,000 hard ceiling on ANY single computed charge
};

export function slugify(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
export function isSlug(s) { return /^[a-z0-9][a-z0-9-]{0,39}$/.test(String(s || '')); }

// Parse a non-negative integer (cents / makes) from a number or a plain digit string.
// Rejects anything else (floats, signs, junk) so money math is always on clean integers.
export function intOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v >= 0 ? Math.round(v) : null;
  if (typeof v === 'string' && /^\d{1,9}$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}
function clampInt(v, min, max) { return Math.max(min, Math.min(max, v)); }

// AUTHORITATIVE charge for a pledge given a player's made-shot count, in cents.
//   flat     → the flat gift (clamped to its bounds)
//   per_shot → perShot × makes, then the optional cap, then the hard ceiling
// Returns 0 for anything below the minimum (so it is never invoiced). Never trusts the browser.
export function computePledgeCents(pledge, makes) {
  if (!pledge) return 0;
  if (pledge.kind === 'flat') {
    const f = intOrNull(pledge.flat_cents) || 0;
    if (f < LIMITS.minFlatCents) return 0;
    return clampInt(f, 0, LIMITS.maxFlatCents);
  }
  // per_shot
  const per = intOrNull(pledge.per_shot_cents) || 0;
  if (per < LIMITS.minPerShotCents) return 0;
  const perC = clampInt(per, 0, LIMITS.maxPerShotCents);
  const m = clampInt(intOrNull(makes) || 0, 0, LIMITS.maxMakes);
  let raw = perC * m;
  const cap = intOrNull(pledge.cap_cents) || 0;
  if (cap > 0) raw = Math.min(raw, clampInt(cap, 0, LIMITS.maxCapCents));
  return clampInt(raw, 0, LIMITS.maxChargeCents);
}

// Validate + sanitize an incoming pledge. The player's existence is checked by the
// endpoint against the live event roster (here we only vet the slug FORMAT).
// Returns { ok:true, pledge } with a clean object, or { ok:false, error }.
export function normalizePledge(body) {
  const b = body || {};
  // Honeypot — same hidden-field convention as the clinic form.
  if (String(b.dba_ref || b.company || '').trim()) return { ok: false, error: 'spam' };

  const kind = b.kind === 'flat' ? 'flat' : 'per_shot';
  const donor_name = stripTags(clip(b.donor_name, 120)).trim();
  const donor_email = clip(b.donor_email, 200).trim().toLowerCase();
  if (!donor_name) return { ok: false, error: 'missing_name' };
  if (!validEmail(donor_email)) return { ok: false, error: 'bad_email' };

  const player_slug = String(b.player_slug || 'general').trim().toLowerCase();
  if (player_slug !== 'general' && !isSlug(player_slug)) return { ok: false, error: 'bad_player' };
  // A per-shot pledge must back a specific player — a general per-shot pledge has no makes to count.
  if (kind === 'per_shot' && player_slug === 'general') return { ok: false, error: 'per_shot_needs_player' };

  const pledge = {
    event_id: SHOOTATHON.eventId,
    kind,
    player_slug,
    donor_name,
    donor_email,
    message: stripTags(clip(b.message, 280)).trim(),
    anonymous: b.anonymous ? true : false,
  };

  if (kind === 'flat') {
    const f = intOrNull(b.flat_cents);
    if (f == null || f < LIMITS.minFlatCents || f > LIMITS.maxFlatCents) return { ok: false, error: 'bad_amount' };
    pledge.flat_cents = f;
    pledge.per_shot_cents = 0;
    pledge.cap_cents = 0;
  } else {
    const per = intOrNull(b.per_shot_cents);
    if (per == null || per < LIMITS.minPerShotCents || per > LIMITS.maxPerShotCents) return { ok: false, error: 'bad_per_shot' };
    let cap = intOrNull(b.cap_cents);
    if (cap == null) cap = 0;
    // A cap is optional (0 = no cap); if set it must be worth at least one made shot and within the ceiling.
    if (cap !== 0 && (cap < per || cap > LIMITS.maxCapCents)) return { ok: false, error: 'bad_cap' };
    pledge.per_shot_cents = per;
    pledge.cap_cents = cap;
    pledge.flat_cents = 0;
  }
  return { ok: true, pledge };
}

export function dollars(cents) { return '$' + ((cents || 0) / 100).toFixed(2); }

// A short, human description of what a supporter pledged (used in emails + the admin list).
//   per_shot → "$0.50 per made shot (up to $100)"   flat → "$300 one-time gift"
export function pledgeDescription(pledge) {
  if (!pledge) return '';
  if (pledge.kind === 'flat') return `${dollars(pledge.flat_cents)} one-time gift`;
  const base = `${dollars(pledge.per_shot_cents)} per made shot`;
  return pledge.cap_cents > 0 ? `${base} (up to ${dollars(pledge.cap_cents)})` : base;
}
