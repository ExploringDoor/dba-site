// ─────────────────────────────────────────────────────────────────────────
// Downer Basketball Academy — Fall Clinic config, pricing, and validation.
// This is the AUTHORITATIVE source of prices and rules. The browser sends what
// the parent picked; the server recomputes the real amount here so a tampered
// request can never undercharge. Mirrors the STS "expectedCents" guard.
// ─────────────────────────────────────────────────────────────────────────

// The six Sunday sessions for Fall 2026 (Sep 27 – Nov 1). The ids are what get
// stored — keep them stable; only edit labels if dates change. Keep in sync with
// register.html (SESSIONS) and admin.html (SESSION_LABELS).
export const SESSIONS = [
  { id: 's1', label: 'Session 1 — Sun, Sep 27', date: '2026-09-27' },
  { id: 's2', label: 'Session 2 — Sun, Oct 4',  date: '2026-10-04' },
  { id: 's3', label: 'Session 3 — Sun, Oct 11', date: '2026-10-11' },
  { id: 's4', label: 'Session 4 — Sun, Oct 18', date: '2026-10-18' },
  { id: 's5', label: 'Session 5 — Sun, Oct 25', date: '2026-10-25' },
  { id: 's6', label: 'Session 6 — Sun, Nov 1',  date: '2026-11-01' },
];
export const SESSION_IDS = SESSIONS.map((s) => s.id);

// All-in prices (what the parent pays), in cents. Matches the RYZER model:
// $30 base + $8 processing = $38/session; $150 + $14 = $164 for all six.
// We charge the all-in amount; the base/fee split is stored only for reporting.
export const PRICE = {
  perSessionCents: 3800,
  allSixCents: 16400,
  baseSessionCents: 3000,
  feeSessionCents: 800,
  baseAllSixCents: 15000,
  feeAllSixCents: 1400,
  currency: 'USD',
};

export const CLINIC = {
  id: 'fall-2026',
  title: 'DBA Fall Clinics 2026',
  location: 'Kobe Bryant Gymnasium, Lower Merion HS, Ardmore PA',
  ageRange: '6–14',
};

export function clip(v, n) { return String(v == null ? '' : v).slice(0, n); }
export function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '')); }
// Strip HTML metacharacters from free-text fields at intake — defense in depth so a
// stored value can never carry markup into any downstream renderer or email.
export function stripTags(s) { return String(s == null ? '' : s).replace(/[<>]/g, ''); }

// Which valid, de-duplicated sessions did they actually pick?
export function cleanSessions(sessions) {
  const set = new Set();
  (Array.isArray(sessions) ? sessions : []).forEach((s) => { if (SESSION_IDS.includes(s)) set.add(s); });
  return SESSION_IDS.filter((id) => set.has(id)); // canonical order
}

// AUTHORITATIVE price. Never trust any amount from the browser.
export function expectedCents(reg) {
  const n = cleanSessions(reg && reg.sessions).length;
  const players = Array.isArray(reg && reg.players) ? reg.players.length : 0;
  if (n === 0 || players === 0) return 0;
  const perPlayer = (n === SESSION_IDS.length) ? PRICE.allSixCents : n * PRICE.perSessionCents;
  return perPlayer * players;
}

// Receipt helpers ─────────────────────────────────────────────────────────
// Split the authoritative total into base + processing (for an itemized receipt).
export function priceBreakdown(reg) {
  const n = cleanSessions(reg && reg.sessions).length;
  const players = Array.isArray(reg && reg.players) ? reg.players.length : 0;
  const allSix = n === SESSION_IDS.length;
  const basePer = allSix ? PRICE.baseAllSixCents : n * PRICE.baseSessionCents;
  const feePer = allSix ? PRICE.feeAllSixCents : n * PRICE.feeSessionCents;
  return {
    base_cents: basePer * players,
    fee_cents: feePer * players,
    total_cents: (basePer + feePer) * players,
    all_six: allSix,
    session_count: n,
    player_count: players,
  };
}
// The chosen sessions as human date labels, e.g. ["Sun, Sep 27", "Sun, Oct 11"].
export function sessionLabels(reg) {
  const chosen = cleanSessions(reg && reg.sessions);
  return SESSIONS.filter((s) => chosen.includes(s.id)).map((s) => s.label.replace(/^Session \d+ — /, ''));
}

// Validate + sanitize an incoming registration body. Returns
// { ok:true, reg } with a clean object, or { ok:false, error }.
export function normalizeRegistration(body) {
  const b = body || {};
  // Honeypot: a hidden "company" field no real user ever fills. Bots do → reject.
  if (String(b.company || '').trim()) return { ok: false, error: 'spam' };
  const sessions = cleanSessions(b.sessions);
  if (!sessions.length) return { ok: false, error: 'no_sessions' };

  const players = (Array.isArray(b.players) ? b.players : []).map((p) => ({
    first: stripTags(clip(p && p.first, 60)).trim(),
    last: stripTags(clip(p && p.last, 60)).trim(),
    dob: clip(p && p.dob, 20).trim(),
    grade: stripTags(clip(p && p.grade, 30)).trim(),
  })).filter((p) => p.first || p.last || p.dob);
  if (!players.length) return { ok: false, error: 'no_players' };
  if (players.length > 8) return { ok: false, error: 'too_many_players' };
  if (players.some((p) => !p.first || !p.last || !p.dob)) return { ok: false, error: 'incomplete_player' };

  const parent_email = clip(b.parent_email, 200).trim();
  if (!validEmail(parent_email)) return { ok: false, error: 'bad_email' };
  const parent_name = stripTags(clip(b.parent_name, 200)).trim();
  const parent_phone = clip(b.parent_phone, 60).trim();
  const emerg_name = stripTags(clip(b.emerg_name, 200)).trim();
  const emerg_phone = clip(b.emerg_phone, 60).trim();
  if (!parent_name || !parent_phone || !emerg_name || !emerg_phone) return { ok: false, error: 'missing_contact' };

  const waiver_name = stripTags(clip(b.waiver_name, 120)).trim();
  if (!b.waiver_agree || !waiver_name) return { ok: false, error: 'waiver_required' };

  const reg = {
    clinic_id: CLINIC.id,
    clinic_title: CLINIC.title,
    sessions,
    session_count: sessions.length,
    all_six: sessions.length === SESSION_IDS.length,
    players,
    player_count: players.length,
    parent_name,
    parent_rel: stripTags(clip(b.parent_rel, 80)).trim(),
    parent_email,
    parent_phone,
    emerg_name,
    emerg_phone,
    pickup_name: stripTags(clip(b.pickup_name, 120)).trim(),
    pickup_phone: clip(b.pickup_phone, 60).trim(),
    allergies: stripTags(clip(b.allergies, 300)).trim(),
    medications: stripTags(clip(b.medications, 300)).trim(),
    medical_conditions: stripTags(clip(b.medical_conditions, 1000)).trim(),
    treat_ok: b.treat_ok ? true : false,
    photo: b.photo ? true : false,
    waiver_name,
  };
  return { ok: true, reg };
}
