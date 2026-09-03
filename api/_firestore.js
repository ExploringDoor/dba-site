// Shared Firestore REST helpers for STS serverless functions.
// No firebase-admin / downloaded service-account key (the org policy
// `iam.disableServiceAccountKeyCreation` blocks those, and they're a leak risk).
// Instead the server signs in as ONE dedicated Firebase Auth admin user and
// sends that user's ID token as Bearer auth on every write — which satisfies the
// `isSuper()` security rule. Reads of public collections still work key-only.
//
// Env (Vercel project settings):
//   FIREBASE_PROJECT_ID, FIREBASE_API_KEY      — project + web API key
//   FB_ADMIN_EMAIL, FB_ADMIN_PASSWORD          — the dedicated server admin login
//                                                (its uid must have an admins/{uid}
//                                                 doc with role:'super', active:true)

const FB_PROJECT = process.env.FIREBASE_PROJECT_ID || 'PASTE_PROJECT_ID';
const FB_KEY = process.env.FIREBASE_API_KEY || '';
const FB_BASE = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

const FB_ADMIN_EMAIL = process.env.FB_ADMIN_EMAIL || '';
const FB_ADMIN_PASSWORD = process.env.FB_ADMIN_PASSWORD || '';

export function fbConfigured() { return !!FB_KEY && !FB_PROJECT.startsWith('PASTE'); }
// True when the server can authenticate as the admin user (privileged writes).
export function fbAdminConfigured() { return fbConfigured() && !!FB_ADMIN_EMAIL && !!FB_ADMIN_PASSWORD; }

// ── Admin sign-in (Identity Toolkit) ─────────────────────────────────
// Exchanges the dedicated admin email+password for a short-lived ID token,
// cached in warm-invocation module scope until ~1 min before it expires.
let _tok = null, _tokExp = 0, _uid = '', _signInFlight = null;
export async function adminIdToken() {
  if (!fbAdminConfigured()) return null;
  const now = Date.now();
  if (_tok && now < _tokExp) return _tok;
  // Collapse concurrent sign-ins: if several requests hit this warm instance before the
  // token is cached, they all await ONE in-flight signInWithPassword instead of each firing
  // their own. Without this, a cold instance handling a small burst could send N simultaneous
  // password verifications and nudge Firebase toward its QUOTA_EXCEEDED throttle — which also
  // starves the sign-in the charge/registration endpoints depend on. (The high-traffic VIEW
  // path is already off admin auth: /api/public-data reads key-only.)
  if (_signInFlight) return _signInFlight;
  _signInFlight = (async () => {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FB_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: FB_ADMIN_EMAIL, password: FB_ADMIN_PASSWORD, returnSecureToken: true })
    });
    const d = await r.json();
    if (!r.ok || !d.idToken) throw new Error('admin auth failed: ' + (d.error?.message || r.status));
    _tok = d.idToken;
    _uid = d.localId || _uid;
    _tokExp = Date.now() + (parseInt(d.expiresIn, 10) || 3600) * 1000 - 60000;   // refresh 1 min early
    return _tok;
  })();
  try {
    return await _signInFlight;
  } finally {
    _signInFlight = null;   // let the next expiry re-sign-in; a failure must not pin a rejected promise
  }
}
export function adminUid() { return _uid; }
// Authorization header for privileged calls (empty object when no admin creds,
// so the helpers degrade to the old key-only behaviour for public reads).
async function authHeader() {
  const t = await adminIdToken().catch(() => null);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export function toFsValue(v) {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (v === null || v === undefined) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFirestore(v) } };
  return { stringValue: String(v) };
}
export function toFirestore(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = toFsValue(v);
  return out;
}
export function fromFsValue(v) {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue) return (v.arrayValue.values || []).map(fromFsValue);
  if (v.mapValue) return fromFirestore(v.mapValue.fields || {});
  return null;
}
export function fromFirestore(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = fromFsValue(v);
  return out;
}

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

// Reject any path segment that could escape its collection. Firestore document ids never
// legitimately contain '/', '.' or '..'; without this guard a client-controlled id like
// '../admins/x' interpolated into the REST URL traverses to another collection under the
// privileged admin token (the WHATWG URL parser collapses '/../'). Defense in depth behind
// the per-endpoint id validation — every write helper refuses an unsafe path.
export function pathSafe(p) {
  return typeof p === 'string' && p.length > 0 &&
    !p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

export async function fsGet(path) {
  const m = await fsGetMeta(path);
  return m ? m.doc : null;
}
// Like fsGet, but also returns Firestore's `updateTime` so a caller can make a conditional
// write (see fsPatchVerified's `ifUpdateTime`) — the building block for "claim before send".
// Returns null ONLY when the document doesn't exist. Any other failure (auth blip, 5xx,
// network) THROWS — so a caller can never mistake "Firestore is down" for "not found"
// (which would e.g. tell a parent who just paid that their registration doesn't exist, or
// let checkout sell a cancelled Sunday). Handlers that don't catch return 500, which is the
// honest answer: the success page keeps polling, Stripe retries the webhook, the cron re-runs.
export async function fsGetMeta(path) {
  if (!pathSafe(path)) return null;
  const r = await fetch(`${FB_BASE}/${path}?key=${FB_KEY}`, { headers: await authHeader() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('firestore_read_failed_' + r.status);
  const d = await r.json();
  if (!d.fields) return null;
  return { doc: { id: String(d.name).split('/').pop(), ...fromFirestore(d.fields) }, updateTime: d.updateTime || '' };
}
export async function fsPatch(path, fields) {
  if (!pathSafe(path)) return { error: { status: 'INVALID_ARGUMENT', code: 400, message: 'unsafe path' } };
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const r = await fetch(`${FB_BASE}/${path}?${mask}&key=${FB_KEY}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ fields: toFirestore(fields) })
  });
  return r.json();
}
// Like fsPatch, but REPORTS success/failure and retries transient errors (429 / 5xx /
// network). Use for money-critical writes — marking a charged registration paid — where a
// silently-dropped PATCH would leave a charged entry looking unpaid and thus re-chargeable.
// Returns { ok:true, data } or { ok:false, status, error }.
// opts.ifUpdateTime — only apply if the document's updateTime still equals this value (from
// fsGetMeta). If someone else wrote in between, Firestore answers 400 FAILED_PRECONDITION and
// we return { ok:false, status:400/412 } WITHOUT retrying — that's the "lost the race" signal.
export async function fsPatchVerified(path, fields, tries = 4, opts = {}) {
  if (!pathSafe(path)) return { ok: false, status: 400, error: { message: 'unsafe path' } };
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const pre = opts && opts.ifUpdateTime ? `&currentDocument.updateTime=${encodeURIComponent(opts.ifUpdateTime)}` : '';
  let last = { ok: false, status: 0, error: { message: 'no attempt' } };
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${FB_BASE}/${path}?${mask}${pre}&key=${FB_KEY}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ fields: toFirestore(fields) })
      });
      if (r.ok) return { ok: true, data: await r.json().catch(() => ({})) };
      const d = await r.json().catch(() => ({}));
      last = { ok: false, status: r.status, error: (d && d.error) || { message: 'http ' + r.status } };
      if (r.status < 500 && r.status !== 429) return last;   // 4xx (except rate-limit) won't improve on retry
    } catch (e) {
      last = { ok: false, status: 0, error: { message: String((e && e.message) || e) } };
    }
    if (i < tries - 1) await sleep(150 * (i + 1));
  }
  return last;
}
export async function fsCreate(collection, fields, docId) {
  if (!pathSafe(collection) || (docId != null && !pathSafe(String(docId)))) {
    return { error: { status: 'INVALID_ARGUMENT', code: 400, message: 'unsafe path' } };
  }
  const url = docId
    ? `${FB_BASE}/${collection}?documentId=${encodeURIComponent(docId)}&key=${FB_KEY}`
    : `${FB_BASE}/${collection}?key=${FB_KEY}`;
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ fields: toFirestore(fields) })
  });
  return r.json();
}
// List an entire collection (admin-token, so it also works for the PII-gated ones the robot
// can read). Callers must strip anything sensitive before returning it publicly.
export async function fsList(collection) {
  const auth = await authHeader();
  const out = [];
  let token = '';
  do {
    const url = `${FB_BASE}/${collection}?pageSize=300` + (token ? `&pageToken=${encodeURIComponent(token)}` : '') + `&key=${FB_KEY}`;
    const r = await fetch(url, { headers: auth });
    // A failed page must not look like "the collection is just short" — the reconcile cron
    // would then write a green heartbeat having checked nothing. Throw instead.
    if (!r.ok) throw new Error('firestore_list_failed_' + r.status);
    const d = await r.json();
    (d.documents || []).forEach((doc) => out.push({ id: String(doc.name).split('/').pop(), ...fromFirestore(doc.fields || {}) }));
    token = d.nextPageToken || '';
  } while (token);
  return out;
}
export async function fsQuery(collection, field, op, value) {
  const r = await fetch(`${FB_BASE}:runQuery?key=${FB_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: collection }],
        where: { fieldFilter: { field: { fieldPath: field }, op, value: toFsValue(value) } }
      }
    })
  });
  const data = await r.json();
  return (Array.isArray(data) ? data : []).filter(d => d.document).map(d => ({
    id: d.document.name.split('/').pop(), ...fromFirestore(d.document.fields)
  }));
}
