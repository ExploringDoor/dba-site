// ─────────────────────────────────────────────────────────────────────────
// Downer Basketball Academy — Shoot-a-Thon (free-throw fundraiser).
// Config, validation, and the AUTHORITATIVE amount computation.
//
// Model (locked with Adam, GivingZone-style):
//   • Every athlete shoots free throws. A supporter either SPONSORS a player PER MADE
//     free throw ($0.25–$10, optional cap) or makes a ONE-TIME donation.
//   • One-time donations are paid IMMEDIATELY (Stripe hosted checkout, no stored cards) and
//     count toward the thermometers right away. Per-made-throw PLEDGES are billed AFTER the
//     event: the admin enters each player's made count, then emails secure pay-links.
//   • Three levels, each with a goal, and donations ROLL UP: a gift to a player counts toward
//     that player's goal, their team's goal, and the whole organization's goal.
//       organization  (default $30,000)
//         team        (default $10,000 each — e.g. Varsity / JV / Freshman)
//           player    (default $1,000 each)
//
// Money routing mirrors the clinics: collected by Always Competing Sports LLC on behalf of the
// organizing booster club (a 501(c)(3)) and remitted in full — the booster club issues the
// tax-deductible acknowledgment.
//
// Like _clinic.js, THIS FILE is the server-side source of truth for money bounds. The browser
// sends what the supporter picked; the server clamps / recomputes here, and the final per-shot
// charge is always recomputed from the stored pledge × the admin-entered makes — never trusted
// from a browser.
// ─────────────────────────────────────────────────────────────────────────

import { clip, stripTags, validEmail } from './_clinic.js';

export const SHOOTATHON = {
  eventId: process.env.SHOOTATHON_EVENT_ID || 'fall-2026',
  title: 'Aces Shoot-a-Thon',
  boosterName: process.env.BOOSTER_NAME || "the clinic's organizing booster club",
  boosterEin: process.env.BOOSTER_EIN || '',
  // Default goals (the admin can override any of these in the event doc).
  defaultOrgGoalCents: 3000000,     // $30,000 — the whole organization
  defaultTeamGoalCents: 1000000,    // $10,000 — each team
  defaultPlayerGoalCents: 100000,   // $1,000 — each player
};

// Authoritative money bounds. A pledge outside these is rejected at intake; the final computed
// charge is also hard-clamped to maxChargeCents.
export const LIMITS = {
  minPerShotCents: 25,       // $0.25 per made free throw
  maxPerShotCents: 1000,     // $10.00 per made free throw
  maxCapCents: 1000000,      // $10,000 cap ceiling
  minFlatCents: 500,         // $5 minimum one-time donation
  maxFlatCents: 2000000,     // $20,000 maximum one-time donation
  maxMakes: 150,             // a player can be credited at most 150 made throws
  maxChargeCents: 2000000,   // $20,000 hard ceiling on ANY single computed charge
  maxGoalCents: 100000000,   // $1,000,000 ceiling on any goal
};

export function slugify(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
export function isSlug(s) { return /^[a-z0-9][a-z0-9-]{0,39}$/.test(String(s || '')); }

// Parse a non-negative integer (cents / makes) from a number or a plain digit string.
export function intOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v >= 0 ? Math.round(v) : null;
  if (typeof v === 'string' && /^\d{1,9}$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}
function clampInt(v, min, max) { return Math.max(min, Math.min(max, v)); }

// AUTHORITATIVE charge for a pledge given a player's made-throw count, in cents.
//   flat     → the one-time donation (clamped to its bounds)
//   per_shot → perShot × makes, then the optional cap, then the hard ceiling
// Returns 0 for anything below the minimum (so it is never invoiced).
export function computePledgeCents(pledge, makes) {
  if (!pledge) return 0;
  if (pledge.kind === 'flat') {
    const f = intOrNull(pledge.flat_cents) || 0;
    if (f < LIMITS.minFlatCents) return 0;
    return clampInt(f, 0, LIMITS.maxFlatCents);
  }
  const per = intOrNull(pledge.per_shot_cents) || 0;
  if (per < LIMITS.minPerShotCents) return 0;
  const perC = clampInt(per, 0, LIMITS.maxPerShotCents);
  const m = clampInt(intOrNull(makes) || 0, 0, LIMITS.maxMakes);
  let raw = perC * m;
  const cap = intOrNull(pledge.cap_cents) || 0;
  if (cap > 0) raw = Math.min(raw, clampInt(cap, 0, LIMITS.maxCapCents));
  return clampInt(raw, 0, LIMITS.maxChargeCents);
}

// Validate + sanitize an incoming pledge/donation. The TARGET (org / team / player) existence is
// checked by the endpoint against the live event; here we vet shape + format only.
// Returns { ok:true, pledge } with a clean object, or { ok:false, error }.
export function normalizePledge(body) {
  const b = body || {};
  if (String(b.dba_ref || b.company || '').trim()) return { ok: false, error: 'spam' };

  const kind = b.kind === 'flat' ? 'flat' : 'per_shot';

  // Target: what the gift supports. org = the whole program, team = a whole team, player = one athlete.
  let target_type = String(b.target_type || '').toLowerCase();
  if (!['org', 'team', 'player'].includes(target_type)) {
    // Back-compat / convenience: a bare player_slug or the legacy 'general' still work.
    if (b.player_slug && b.player_slug !== 'general') { target_type = 'player'; }
    else target_type = 'org';
  }
  let target_slug = '';
  if (target_type === 'player') target_slug = String(b.target_slug || b.player_slug || '').trim().toLowerCase();
  else if (target_type === 'team') target_slug = String(b.target_slug || '').trim().toLowerCase();
  if (target_type !== 'org' && !isSlug(target_slug)) return { ok: false, error: 'bad_target' };

  // A per-made-throw pledge must sponsor a specific PLAYER (only players shoot).
  if (kind === 'per_shot' && target_type !== 'player') return { ok: false, error: 'per_shot_needs_player' };

  const donor_name = stripTags(clip(b.donor_name, 120)).trim();
  const donor_email = clip(b.donor_email, 200).trim().toLowerCase();
  if (!donor_name) return { ok: false, error: 'missing_name' };
  if (!validEmail(donor_email)) return { ok: false, error: 'bad_email' };

  const pledge = {
    event_id: SHOOTATHON.eventId,
    kind,
    target_type,
    target_slug,
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
    if (cap !== 0 && (cap < per || cap > LIMITS.maxCapCents)) return { ok: false, error: 'bad_cap' };
    pledge.per_shot_cents = per;
    pledge.cap_cents = cap;
    pledge.flat_cents = 0;
  }
  return { ok: true, pledge };
}

export function dollars(cents) { return '$' + ((cents || 0) / 100).toFixed(2); }

// A short, human description of a pledge/donation (emails + admin list).
export function pledgeDescription(pledge) {
  if (!pledge) return '';
  if (pledge.kind === 'flat') return `${dollars(pledge.flat_cents)} one-time donation`;
  const base = `${dollars(pledge.per_shot_cents)} per made free throw`;
  return pledge.cap_cents > 0 ? `${base} (up to ${dollars(pledge.cap_cents)})` : base;
}

// ── Event-config normalizers (shared by the admin set_event) ───────────────
// A clean team from admin input: { slug, name, goal_cents }. Preserves slug when valid.
export function normalizeTeam(raw, usedSlugs) {
  const name = stripTags(clip(raw && raw.name, 60)).trim();
  if (!name) return null;
  let slug = (raw && raw.slug && isSlug(String(raw.slug))) ? String(raw.slug) : slugify(name);
  if (!slug) slug = 'team';
  let unique = slug, n = 2;
  while (usedSlugs && usedSlugs.has(unique)) unique = `${slug}-${n++}`.slice(0, 40);
  if (usedSlugs) usedSlugs.add(unique);
  const g = intOrNull(raw && raw.goal_cents);
  const goal_cents = g == null ? SHOOTATHON.defaultTeamGoalCents : Math.min(g, LIMITS.maxGoalCents);
  return { slug: unique, name, goal_cents };
}
