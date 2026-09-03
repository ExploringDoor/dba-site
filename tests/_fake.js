// tests/_fake.js — in-memory stand-ins for every external service the /api functions talk to,
// installed by swapping globalThis.fetch. Lets the REAL server code paths (checkout → confirm /
// webhook / reconcile, remind, notify, checkin, refund) run end-to-end with zero network.
//
//   Firestore REST      GET/PATCH/POST/DELETE documents, list (paged), :runQuery, updateMask,
//                       currentDocument.updateTime preconditions (400 FAILED_PRECONDITION),
//                       and the project's firestore.rules (only registrations/* is writable).
//   Identity Toolkit    accounts:signInWithPassword → idToken the Firestore fake then requires.
//   Stripe              checkout/sessions (create + retrieve, with or without honoured expand),
//                       payment_intents, charges, refunds (with over-refund guard + idempotency).
//   SendGrid            v3/mail/send → 202, every accepted body recorded in state.mail.
//
// Everything the app sends is recorded in state.log; anything the fake has no route for is
// pushed to state.unexpected AND thrown (so the app sees a network failure). Call assertClean()
// at the end of a test to fail loudly on either.
//
// ./_env.js must be evaluated before ../api/_firestore.js (it reads env at import), which is why
// it is the first import here and why flows.test.mjs imports this file before any api module.

import './_env.js';
import { toFirestore, fromFirestore, fromFsValue } from '../api/_firestore.js';
import { expectedCents, cleanSessions, SESSION_IDS, CLINIC } from '../api/_clinic.js';

const RealDate = globalThis.Date; // captured before any test stubs Date (see withNow)
const PID = process.env.FIREBASE_PROJECT_ID;
const FS_HOST = 'firestore.googleapis.com';
const FS_ROOT = `/v1/projects/${PID}/databases/(default)/documents`;
const DOC_PREFIX = `projects/${PID}/databases/(default)/documents/`;
export const FB_BASE = `https://${FS_HOST}${FS_ROOT}`;

// ── State ────────────────────────────────────────────────────────────────
export const state = {
  docs: new Map(),        // 'collection/id' → { fields (Firestore typed), createTime, updateTime }
  log: [],                // every fetch: { n, method, url, host, path, query, headers, body, status, response }
  mail: [],               // SendGrid bodies that were ACCEPTED (202), parsed, plus to/bcc convenience lists
  unexpected: [],         // routes/ops the fake could not model — a test should fail if any appear
  stripe: { sessions: new Map(), intents: new Map(), charges: new Map(), refunds: [], idem: new Map(), failSessions: new Set() },
  auth: { tokens: new Set() }, // survives reset(): api/_firestore.js caches its ID token in module scope
  opts: null,
  ids: null,
};
const defaultOpts = () => ({
  latency: true,            // yield to the event loop per request (so concurrent handlers interleave like real I/O)
  stripeNestExpand: false,  // false: Stripe returns payment_intent/latest_charge as bare ids (the app must fetch them)
  listPageSize: 0,          // >0 forces Firestore list pagination regardless of the requested pageSize
  fail: { firestore: 0, stripe: 0, sendgrid: 0 }, // non-zero HTTP status → every call to that service fails
});
function resetIds() { state.ids = { seq: 0, doc: 0, cs: 0, pi: 0, ch: 0, re: 0, tok: state.ids ? state.ids.tok : 0, ts: 0, reg: 0 }; }

// Fake Firestore clock: strictly monotonic, unique per write, RFC3339 with micros like the real thing.
const T0 = RealDate.parse('2026-09-01T12:00:00Z');
function stamp() { return new RealDate(T0 + (++state.ids.ts)).toISOString().replace('Z', '000Z'); }
function readTime() { return new RealDate(T0 + state.ids.ts).toISOString().replace('Z', '000Z'); }

// ── Response / request plumbing ──────────────────────────────────────────
class NoRoute extends TypeError {}
function reply(status, body, headers) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const r = new Response(text, { status, headers: { 'content-type': 'application/json; charset=UTF-8', ...(headers || {}) } });
  r._body = body;
  return r;
}
const gerr = (code, status, message) => ({ error: { code, message, status } });

function lowerHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && !Array.isArray(h)) { h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); }); return out; }
  for (const [k, v] of (Array.isArray(h) ? h : Object.entries(h))) out[String(k).toLowerCase()] = String(v);
  return out;
}
function parseBody(raw, headers) {
  if (raw == null) return null;
  const s = Buffer.isBuffer(raw) ? raw.toString('utf8') : (raw instanceof URLSearchParams ? raw.toString() : String(raw));
  const ct = String(headers['content-type'] || '');
  if (ct.includes('json')) { try { return JSON.parse(s); } catch (e) { return { __unparsable: s }; } }
  if (ct.includes('x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(s));
  return s;
}

async function fakeFetch(input, init) {
  init = init || {};
  const url = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : String(input));
  const method = String(init.method || 'GET').toUpperCase();
  const headers = lowerHeaders(init.headers);
  const entry = { n: ++state.ids.seq, method, url, host: '', path: '', query: null, headers, body: parseBody(init.body, headers), status: 0, response: undefined };
  state.log.push(entry);
  if (state.opts.latency) await new Promise((r) => setImmediate(r)); // cross the event loop like a real socket would
  let u;
  try { u = new URL(url); } catch (e) { state.unexpected.push(`${method} ${url}: invalid URL`); throw new TypeError('fetch failed: invalid URL ' + url); }
  entry.host = u.hostname; entry.path = u.pathname; entry.query = u.searchParams;
  let r;
  try {
    if (u.hostname === 'identitytoolkit.googleapis.com') r = identityToolkit(entry, u);
    else if (u.hostname === FS_HOST) r = firestore(entry, u);
    else if (u.hostname === 'api.stripe.com') r = stripeApi(entry, u);
    else if (u.hostname === 'api.sendgrid.com') r = sendgrid(entry, u);
    else { state.unexpected.push(`${method} ${url}: no fake route`); entry.status = -1; throw new NoRoute('fetch failed: no fake route for ' + url); }
  } catch (e) {
    if (!(e instanceof NoRoute)) state.unexpected.push(`${method} ${url}: fake crashed: ${e.message}`);
    entry.error = String(e.message || e);
    throw e; // the app sees what it would see on a dead socket: a rejected fetch
  }
  entry.status = r.status; entry.response = r._body;
  return r;
}

// ── Identity Toolkit ─────────────────────────────────────────────────────
function identityToolkit(e, u) {
  if (e.method !== 'POST' || u.pathname !== '/v1/accounts:signInWithPassword') { state.unexpected.push(`${e.method} ${e.url}`); return reply(404, gerr(404, 'NOT_FOUND', 'unknown identitytoolkit method')); }
  if (u.searchParams.get('key') !== process.env.FIREBASE_API_KEY) return reply(400, gerr(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.'));
  const b = e.body || {};
  if (b.email !== process.env.FB_ADMIN_EMAIL || b.password !== process.env.FB_ADMIN_PASSWORD) return reply(400, { error: { code: 400, message: 'INVALID_LOGIN_CREDENTIALS', errors: [{ message: 'INVALID_LOGIN_CREDENTIALS', domain: 'global', reason: 'invalid' }] } });
  const tok = 'idtok_' + (++state.ids.tok);
  state.auth.tokens.add(tok);
  return reply(200, { kind: 'identitytoolkit#VerifyPasswordResponse', localId: 'uid_server_admin', email: b.email, displayName: '', idToken: tok, registered: true, refreshToken: 'rt_' + tok, expiresIn: '3600' });
}

// ── Firestore REST ───────────────────────────────────────────────────────
const docJson = (path, d) => ({ name: DOC_PREFIX + path, fields: d.fields, createTime: d.createTime, updateTime: d.updateTime });
const topLevel = (coll) => [...state.docs.entries()].filter(([p]) => p.startsWith(coll + '/') && p.split('/').length === 2).sort((a, b) => (a[0] < b[0] ? -1 : 1));
const ID_RE = /^[^/]{1,1500}$/;

// Field paths: a.b.c, with `backtick` quoting for anything that isn't [A-Za-z_][A-Za-z0-9_]*.
const SIMPLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function splitFieldPath(fp) {
  const segs = []; let i = 0; fp = String(fp);
  if (!fp) throw new Error('empty field path');
  while (i < fp.length) {
    if (fp[i] === '`') {
      const j = fp.indexOf('`', i + 1); if (j < 0) throw new Error(`unterminated quoted field path: ${fp}`);
      segs.push(fp.slice(i + 1, j)); i = j + 1;
      if (i < fp.length) { if (fp[i] !== '.') throw new Error(`bad field path: ${fp}`); i++; }
    } else {
      let j = fp.indexOf('.', i); if (j < 0) j = fp.length;
      const s = fp.slice(i, j);
      if (!SIMPLE.test(s)) throw new Error(`invalid field path segment "${s}" in "${fp}" (must be backtick-quoted)`);
      segs.push(s); i = j + 1;
    }
  }
  return segs;
}
function getIn(fields, segs) {
  let cur = fields ? fields[segs[0]] : undefined;
  for (let i = 1; i < segs.length && cur; i++) cur = cur.mapValue && cur.mapValue.fields ? cur.mapValue.fields[segs[i]] : undefined;
  return cur;
}
function setIn(fields, segs, value) {
  let cur = fields;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    if (!cur[k] || !cur[k].mapValue) cur[k] = { mapValue: { fields: {} } };
    if (!cur[k].mapValue.fields) cur[k].mapValue.fields = {};
    cur = cur[k].mapValue.fields;
  }
  const last = segs[segs.length - 1];
  if (value === undefined) delete cur[last]; else cur[last] = value;
}

function firestore(e, u) {
  const f = state.opts.fail.firestore;
  if (f) return reply(f, gerr(f, f === 429 ? 'RESOURCE_EXHAUSTED' : 'UNAVAILABLE', 'forced failure'));
  if (!u.pathname.startsWith(FS_ROOT)) { state.unexpected.push(`${e.method} ${e.url}: outside project`); return reply(404, gerr(404, 'NOT_FOUND', 'unknown resource')); }
  const rel = u.pathname.slice(FS_ROOT.length);

  // firestore.rules: every access needs the signed-in server admin; only registrations/{id}
  // is readable+writable, admins/{uid} read-only, everything else denied (even for the admin).
  const auth = String(e.headers['authorization'] || '');
  const signedIn = auth.startsWith('Bearer ') && state.auth.tokens.has(auth.slice(7));
  const denied = () => reply(403, gerr(403, 'PERMISSION_DENIED', 'Missing or insufficient permissions.'));
  const allowed = (coll, write) => signedIn && (coll === 'registrations' || (coll === 'admins' && !write));

  try {
    if (rel === ':runQuery') {
      if (e.method !== 'POST') return reply(405, gerr(405, 'METHOD_NOT_ALLOWED', 'runQuery is POST'));
      const sq = e.body && e.body.structuredQuery;
      const coll = sq && Array.isArray(sq.from) && sq.from[0] && sq.from[0].collectionId;
      if (!coll) throw new Error('runQuery needs structuredQuery.from[0].collectionId');
      if (sq.from[0].allDescendants) throw new Error('allDescendants not modelled');
      if (!allowed(coll, false)) return denied();
      return runQuery(sq, coll);
    }
    const segs = rel.split('/').filter(Boolean);
    if (!segs.length || segs.some((s) => !ID_RE.test(s))) return reply(400, gerr(400, 'INVALID_ARGUMENT', 'bad document path'));
    const write = e.method !== 'GET';
    if (segs.length > 2) return denied(); // the rules only match top-level docs; subcollections are denied
    if (!allowed(segs[0], write)) return denied();
    if (segs.length === 1) {
      if (e.method === 'GET') return listDocs(u, segs[0]);
      if (e.method === 'POST') return createDoc(e, u, segs[0]);
      return reply(405, gerr(405, 'METHOD_NOT_ALLOWED', e.method));
    }
    const path = segs.join('/');
    if (e.method === 'GET') { const d = state.docs.get(path); return d ? reply(200, docJson(path, d)) : reply(404, gerr(404, 'NOT_FOUND', `Document "${DOC_PREFIX + path}" not found.`)); }
    if (e.method === 'PATCH') return patchDoc(e, u, path);
    if (e.method === 'DELETE') { state.docs.delete(path); return reply(200, {}); }
    return reply(405, gerr(405, 'METHOD_NOT_ALLOWED', e.method));
  } catch (err) {
    state.unexpected.push(`${e.method} ${e.url}: ${err.message}`);
    return reply(400, gerr(400, 'INVALID_ARGUMENT', err.message));
  }
}
function listDocs(u, coll) {
  const size = state.opts.listPageSize || parseInt(u.searchParams.get('pageSize') || '0', 10) || 100;
  const all = topLevel(coll);
  const token = u.searchParams.get('pageToken') || '';
  let start = 0;
  if (token) { const i = all.findIndex(([p]) => p === token); if (i < 0) throw new Error('bad pageToken'); start = i + 1; }
  const page = all.slice(start, start + size);
  const out = {};
  if (page.length) out.documents = page.map(([p, d]) => docJson(p, d));
  if (start + size < all.length) out.nextPageToken = page[page.length - 1][0];
  return reply(200, out);
}
function createDoc(e, u, coll) {
  const id = u.searchParams.get('documentId') || ('fk' + String(++state.ids.doc).padStart(18, '0'));
  const path = coll + '/' + id;
  if (state.docs.has(path)) return reply(409, gerr(409, 'ALREADY_EXISTS', `Document already exists: ${DOC_PREFIX + path}`));
  const fields = (e.body && e.body.fields) || {};
  const now = stamp();
  state.docs.set(path, { fields, createTime: now, updateTime: now });
  return reply(200, docJson(path, state.docs.get(path)));
}
function patchDoc(e, u, path) {
  const mask = u.searchParams.getAll('updateMask.fieldPaths');
  const ifTime = u.searchParams.get('currentDocument.updateTime');
  const ifExists = u.searchParams.get('currentDocument.exists');
  const cur = state.docs.get(path);
  const precondition = (msg) => reply(400, gerr(400, 'FAILED_PRECONDITION', msg));
  if (ifExists === 'true' && !cur) return reply(404, gerr(404, 'NOT_FOUND', `No document to update: ${DOC_PREFIX + path}`));
  if (ifExists === 'false' && cur) return precondition(`Document already exists: ${DOC_PREFIX + path}`);
  if (ifTime != null) {
    if (!cur) return precondition(`No document to update: ${DOC_PREFIX + path}`);
    if (cur.updateTime !== ifTime) return precondition(`the stored version (${cur.updateTime}) does not match the required base version (${ifTime})`);
  }
  const incoming = (e.body && e.body.fields) || {};
  let fields;
  if (mask.length) {
    fields = cur ? JSON.parse(JSON.stringify(cur.fields)) : {};
    for (const fp of mask) { const segs = splitFieldPath(fp); setIn(fields, segs, getIn(incoming, segs)); } // in the mask but absent from the body → deleted
  } else {
    fields = incoming; // no mask: the whole document is replaced
  }
  const now = stamp();
  state.docs.set(path, { fields, createTime: cur ? cur.createTime : now, updateTime: now });
  return reply(200, docJson(path, state.docs.get(path)));
}
function collectFilters(where) {
  if (!where) return [];
  if (where.fieldFilter) return [where.fieldFilter];
  if (where.compositeFilter) { if (where.compositeFilter.op !== 'AND') throw new Error('only AND composite filters are modelled'); return (where.compositeFilter.filters || []).flatMap(collectFilters); }
  if (where.unaryFilter) return [{ field: where.unaryFilter.field, op: where.unaryFilter.op, value: { nullValue: null } }];
  throw new Error('unknown filter shape');
}
function matchFilter(fields, f) {
  const segs = splitFieldPath(f.field && f.field.fieldPath);
  const raw = getIn(fields, segs);
  if (f.op === 'IS_NULL') return raw !== undefined && raw.nullValue !== undefined;
  if (f.op === 'IS_NOT_NULL') return raw !== undefined && raw.nullValue === undefined;
  if (raw === undefined) return false; // a document without the field never matches (real Firestore semantics)
  const a = fromFsValue(raw), b = fromFsValue(f.value);
  const eq = (x, y) => (typeof x === 'object' || typeof y === 'object') ? JSON.stringify(x) === JSON.stringify(y) : x === y;
  switch (f.op) {
    case 'EQUAL': return eq(a, b);
    case 'NOT_EQUAL': return !eq(a, b);
    case 'LESS_THAN': return typeof a === typeof b && a < b;
    case 'LESS_THAN_OR_EQUAL': return typeof a === typeof b && a <= b;
    case 'GREATER_THAN': return typeof a === typeof b && a > b;
    case 'GREATER_THAN_OR_EQUAL': return typeof a === typeof b && a >= b;
    case 'ARRAY_CONTAINS': return Array.isArray(a) && a.some((x) => eq(x, b));
    case 'IN': return Array.isArray(b) && b.some((x) => eq(a, x));
    default: throw new Error('unsupported query op ' + f.op);
  }
}
function runQuery(sq, coll) {
  const filters = collectFilters(sq.where);
  let rows = topLevel(coll).filter(([, d]) => filters.every((f) => matchFilter(d.fields, f)));
  const lim = sq.limit && (typeof sq.limit === 'number' ? sq.limit : sq.limit.value);
  if (lim) rows = rows.slice(0, lim);
  const rt = readTime();
  if (!rows.length) return reply(200, [{ readTime: rt }]); // real Firestore: one element with no `document`
  return reply(200, rows.map(([p, d]) => ({ document: docJson(p, d), readTime: rt })));
}

// ── Stripe ───────────────────────────────────────────────────────────────
const serr = (status, message, extra) => reply(status, { error: { type: status === 401 ? 'invalid_request_error' : (status >= 500 ? 'api_error' : 'invalid_request_error'), message, ...(extra || {}) } });
function newIntent({ id, amount, metadata }) {
  const pi = { id: id || ('pi_' + (++state.ids.pi)), object: 'payment_intent', amount, amount_received: 0, currency: 'usd', status: 'requires_payment_method', latest_charge: null, metadata: metadata || {} };
  state.stripe.intents.set(pi.id, pi);
  return pi;
}
function chargeOf(pi) { return pi.latest_charge ? state.stripe.charges.get(pi.latest_charge) : null; }
function intentView(pi, nestCharge) {
  const ch = chargeOf(pi);
  return { ...pi, latest_charge: nestCharge && ch ? { ...ch } : pi.latest_charge };
}
function stripeApi(e, u) {
  const f = state.opts.fail.stripe;
  if (f) return serr(f, 'forced failure');
  if (String(e.headers['authorization'] || '') !== `Bearer ${process.env.STRIPE_SECRET_KEY}`) return serr(401, 'Invalid API Key provided');
  if (e.method === 'POST' && !String(e.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) return serr(400, 'Invalid request: Stripe expects application/x-www-form-urlencoded bodies');
  const p = u.pathname, expand = u.searchParams.getAll('expand[]');
  let m;
  if (e.method === 'POST' && p === '/v1/checkout/sessions') return createSession(e.body || {});
  if (e.method === 'GET' && (m = p.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))) {
    const id = decodeURIComponent(m[1]);
    if (state.stripe.failSessions.has(id)) return serr(503, 'Stripe is temporarily unavailable (forced)');
    const s = state.stripe.sessions.get(id);
    if (!s) return serr(404, `No such checkout.session: '${id}'`, { param: 'session' });
    const out = { ...s };
    const wantPi = expand.some((x) => x === 'payment_intent' || x.startsWith('payment_intent.'));
    if (wantPi && state.opts.stripeNestExpand && s.payment_intent) out.payment_intent = intentView(state.stripe.intents.get(s.payment_intent), expand.includes('payment_intent.latest_charge'));
    return reply(200, out);
  }
  if (e.method === 'GET' && (m = p.match(/^\/v1\/payment_intents\/([^/]+)$/))) {
    const pi = state.stripe.intents.get(decodeURIComponent(m[1]));
    if (!pi) return serr(404, `No such payment_intent: '${decodeURIComponent(m[1])}'`, { param: 'intent' });
    return reply(200, intentView(pi, state.opts.stripeNestExpand && expand.includes('latest_charge')));
  }
  if (e.method === 'GET' && (m = p.match(/^\/v1\/charges\/([^/]+)$/))) {
    const ch = state.stripe.charges.get(decodeURIComponent(m[1]));
    return ch ? reply(200, { ...ch }) : serr(404, `No such charge: '${decodeURIComponent(m[1])}'`, { param: 'charge' });
  }
  if (e.method === 'POST' && p === '/v1/refunds') return createRefund(e);
  state.unexpected.push(`${e.method} ${e.url}: no Stripe route`);
  return serr(404, `Unrecognized request URL (${e.method}: ${p})`);
}
function createSession(b) {
  if (b.mode !== 'payment') return serr(400, 'mode must be payment', { param: 'mode' });
  if (!b.success_url || !b.cancel_url) return serr(400, 'success_url and cancel_url are required', { param: 'success_url' });
  const qty = parseInt(b['line_items[0][quantity]'] || '0', 10);
  const unit = parseInt(b['line_items[0][price_data][unit_amount]'] || '', 10);
  if (!(qty > 0)) return serr(400, 'line_items[0][quantity] must be a positive integer', { param: 'line_items[0][quantity]' });
  if (!Number.isInteger(unit) || unit <= 0) return serr(400, 'unit_amount must be a positive integer', { param: 'line_items[0][price_data][unit_amount]' });
  if (b.expires_at) { const x = parseInt(b.expires_at, 10), now = Math.floor(RealDate.now() / 1000); if (!(x >= now + 30 * 60 && x <= now + 24 * 3600)) return serr(400, 'expires_at must be between 30 minutes and 24 hours from now', { param: 'expires_at' }); }
  const metadata = {}, piMeta = {};
  for (const [k, v] of Object.entries(b)) {
    let mm = k.match(/^metadata\[(.+)\]$/); if (mm) metadata[mm[1]] = v;
    mm = k.match(/^payment_intent_data\[metadata\]\[(.+)\]$/); if (mm) piMeta[mm[1]] = v;
  }
  const id = 'cs_test_' + (++state.ids.cs);
  const amount = unit * qty;
  const pi = newIntent({ amount, metadata: piMeta });
  const s = {
    id, object: 'checkout.session', mode: 'payment', status: 'open', payment_status: 'unpaid', amount_total: amount,
    currency: b['line_items[0][price_data][currency]'] || 'usd', url: `https://checkout.stripe.com/c/pay/${id}`,
    payment_intent: pi.id, customer_email: b.customer_email || null, client_reference_id: b.client_reference_id || null,
    metadata, success_url: b.success_url, cancel_url: b.cancel_url, expires_at: parseInt(b.expires_at, 10) || null,
    line_item_name: b['line_items[0][price_data][product_data][name]'] || '',
  };
  state.stripe.sessions.set(id, s);
  return reply(200, { ...s });
}
function createRefund(e) {
  const b = e.body || {}, key = e.headers['idempotency-key'] || '';
  if (key && state.stripe.idem.has(key)) { const prev = state.stripe.idem.get(key); return reply(prev.status, prev.body); }
  let status = 200, body;
  const pi = b.payment_intent ? state.stripe.intents.get(b.payment_intent) : null;
  const ch = pi && chargeOf(pi);
  if (!b.payment_intent && !b.charge) { status = 400; body = { error: { type: 'invalid_request_error', message: 'One of the following params should be provided for this request: payment_intent or charge.' } }; }
  else if (!pi) { status = 400; body = { error: { type: 'invalid_request_error', param: 'payment_intent', message: `No such payment_intent: '${b.payment_intent}'` } }; }
  else if (!ch) { status = 400; body = { error: { type: 'invalid_request_error', message: 'This PaymentIntent does not have a successful charge to refund.' } }; }
  else {
    const remaining = ch.amount - ch.amount_refunded;
    const amount = b.amount != null ? parseInt(b.amount, 10) : remaining;
    if (!Number.isInteger(amount) || amount <= 0) { status = 400; body = { error: { type: 'invalid_request_error', param: 'amount', message: 'Invalid positive integer' } }; }
    else if (remaining <= 0) { status = 400; body = { error: { type: 'invalid_request_error', code: 'charge_already_refunded', message: `Charge ${ch.id} has already been refunded.` } }; }
    else if (amount > remaining) { status = 400; body = { error: { type: 'invalid_request_error', message: `Refund amount ($${(amount / 100).toFixed(2)}) is greater than unrefunded amount on charge ($${(remaining / 100).toFixed(2)})` } }; }
    else {
      ch.amount_refunded += amount; ch.refunded = ch.amount_refunded >= ch.amount;
      body = { id: 're_' + (++state.ids.re), object: 'refund', amount, currency: 'usd', status: 'succeeded', payment_intent: pi.id, charge: ch.id, created: Math.floor(RealDate.now() / 1000) };
      state.stripe.refunds.push(body);
    }
  }
  if (key) state.stripe.idem.set(key, { status, body });
  return reply(status, body);
}

// ── SendGrid ─────────────────────────────────────────────────────────────
function sendgrid(e, u) {
  if (process.env.FAKE_TRACE_MAIL) console.error('MAIL#' + (state.mail.length + 1) + ' ' + new Error().stack.split('\n').slice(2, 9).map((l) => l.trim()).join(' <- '));
  if (e.method !== 'POST' || u.pathname !== '/v3/mail/send') { state.unexpected.push(`${e.method} ${e.url}: no SendGrid route`); return reply(404, { errors: [{ message: 'Not Found' }] }); }
  if (String(e.headers['authorization'] || '') !== `Bearer ${process.env.SENDGRID_API_KEY}`) return reply(401, { errors: [{ message: 'The provided authorization grant is invalid, expired, or revoked', field: null }] });
  const b = e.body;
  if (!b || typeof b !== 'object' || b.__unparsable) return reply(400, { errors: [{ message: 'Bad Request', field: 'body' }] });
  const bad = (message, field) => reply(400, { errors: [{ message, field, help: null }] });
  if (!Array.isArray(b.personalizations) || !b.personalizations.length) return bad('The personalizations field is required and must have at least one personalization.', 'personalizations');
  if (b.personalizations.length > 1000) return bad('personalizations may not have more than 1000 entries.', 'personalizations');
  for (let i = 0; i < b.personalizations.length; i++) {
    const p = b.personalizations[i];
    if (!Array.isArray(p.to) || !p.to.length || p.to.some((t) => !t || !/^[^\s@]+@[^\s@]+$/.test(String(t.email || '')))) return bad('The to array is required for all personalization objects, and must have at least one email object with a valid email address.', `personalizations.${i}.to`);
    const seen = new Set();
    for (const t of [].concat(p.to, p.cc || [], p.bcc || [])) { const em = String(t.email).toLowerCase(); if (seen.has(em)) return bad('Each email address in the personalization block should be unique between to, cc, and bcc.', `personalizations.${i}`); seen.add(em); }
  }
  if (!b.from || !b.from.email) return bad('The from object must be provided for every email send. It is an object that requires the email parameter.', 'from.email');
  if (!Array.isArray(b.content) || !b.content.length || b.content.some((c) => !c.value)) return bad('The content value must be a string at least one character in length.', 'content');
  const f = state.opts.fail.sendgrid;
  if (f) return reply(f, { errors: [{ message: 'forced failure', field: null }] });
  state.mail.push({
    n: e.n, ...b,
    to: b.personalizations.flatMap((p) => p.to.map((t) => t.email)),
    bcc: b.personalizations.flatMap((p) => (p.bcc || []).map((t) => t.email)),
    html: (b.content.find((c) => c.type === 'text/html') || {}).value || '',
    text: (b.content.find((c) => c.type === 'text/plain') || {}).value || '',
  });
  return reply(202, undefined, { 'x-message-id': 'fake-' + e.n });
}

// ── Public helpers ───────────────────────────────────────────────────────
let realFetch = null;
export function install() {
  if (globalThis.fetch !== fakeFetch) { realFetch = globalThis.fetch; globalThis.fetch = fakeFetch; }
  if (!state.opts) reset();
}
export function uninstall() { if (realFetch) globalThis.fetch = realFetch; }
export function reset() {
  state.docs.clear(); state.log.length = 0; state.mail.length = 0; state.unexpected.length = 0;
  const s = state.stripe; s.sessions.clear(); s.intents.clear(); s.charges.clear(); s.refunds.length = 0; s.idem.clear(); s.failSessions.clear();
  state.opts = defaultOpts();
  resetIds();
}
export function assertClean() {
  if (state.unexpected.length) throw new Error('fake saw requests it could not model:\n  ' + state.unexpected.join('\n  '));
}

// Firestore seeding / inspection (plain JS objects in, plain objects out).
export function seed(path, obj) {
  const { id, ...rest } = obj || {};
  const now = stamp();
  state.docs.set(path, { fields: toFirestore(rest), createTime: now, updateTime: now });
  return path;
}
export function doc(path) { const d = state.docs.get(path); return d ? { id: path.split('/').pop(), ...fromFirestore(d.fields) } : null; }
export function meta(path) { const d = state.docs.get(path); return d ? { doc: doc(path), createTime: d.createTime, updateTime: d.updateTime } : null; }
export function docs(collection) { return topLevel(collection).map(([p]) => doc(p)); }

// A realistic registration document (what checkout+finalize would have stored). status defaults
// to 'paid'; pass status:'pending' for an unpaid one. Any field can be overridden.
export function regDoc(o = {}) {
  const sessions = cleanSessions(o.sessions || ['s1']);
  const players = o.players || [{ first: 'Kobe', last: 'B', dob: '2015-01-01', grade: '5' }];
  const status = o.status || 'paid';
  const base = {
    clinic_id: CLINIC.id, clinic_title: CLINIC.title,
    sessions, session_count: sessions.length, all_six: sessions.length === SESSION_IDS.length,
    players, player_count: players.length,
    parent_name: 'Jane Doe', parent_rel: 'Mother', parent_email: 'jane@x.com', parent_phone: '610-555-0100',
    emerg_name: 'Ed Doe', emerg_phone: '610-555-0101', pickup_name: '', pickup_phone: '',
    allergies: '', medications: '', medical_conditions: '', treat_ok: true, photo: true,
    waiver_name: 'Jane Doe', waiver_at: '2026-09-01T12:00:00.000Z', waiver_ip: '203.0.113.9',
    status, payment_provider: 'stripe', amount_cents: expectedCents({ sessions, players }), amount_refunded_cents: 0, currency: 'USD',
    created: '2026-09-01T12:00:00.000Z',
  };
  if (status !== 'pending' && status !== 'abandoned' && status !== 'error') {
    Object.assign(base, { paid_at: '2026-09-01T12:01:00.000Z', paid_via: 'Stripe', card_last4: '4242', stripe_session_id: '', stripe_payment_intent: '', amount_captured_cents: base.amount_cents, confirm_email_sent: true, confirm_email_at: '2026-09-01T12:01:01.000Z' });
  }
  return Object.assign(base, o, { sessions, players });
}
export function seedReg(o = {}) {
  const id = o.id || ('reg' + String(++state.ids.reg).padStart(4, '0'));
  seed('registrations/' + id, regDoc(o));
  return id;
}

// Request log queries. filter: { host?, method?, path? (substring or RegExp) }
export function calls(f) {
  f = f || {};
  return state.log.filter((e) =>
    (!f.host || e.host === f.host || e.url.includes(f.host)) &&
    (!f.method || e.method === f.method) &&
    (!f.path || (f.path instanceof RegExp ? f.path.test(e.path || e.url) : (e.path || e.url).includes(f.path))));
}
export const mails = () => state.mail.slice();
export const mailsTo = (email) => state.mail.filter((m) => m.to.includes(email));

// Stripe-side controls.
export const stripe = {
  session: (id) => state.stripe.sessions.get(id) || null,
  intent: (id) => state.stripe.intents.get(id) || null,
  charge: (id) => state.stripe.charges.get(id) || null,
  refunds: () => state.stripe.refunds.slice(),
  // The customer completed hosted checkout: session paid, PaymentIntent succeeded, a charge with a card.
  pay(sessionId, { last4 = '4242' } = {}) {
    const s = state.stripe.sessions.get(sessionId);
    if (!s) throw new Error('no such fake session ' + sessionId);
    const pi = state.stripe.intents.get(s.payment_intent);
    const ch = { id: 'ch_' + (++state.ids.ch), object: 'charge', amount: pi.amount, amount_refunded: 0, refunded: false, paid: true, payment_intent: pi.id, payment_method_details: { type: 'card', card: { brand: 'visa', last4 } } };
    state.stripe.charges.set(ch.id, ch);
    Object.assign(pi, { status: 'succeeded', amount_received: pi.amount, latest_charge: ch.id });
    Object.assign(s, { status: 'complete', payment_status: 'paid' });
    return s;
  },
  // Seed a session that was created "earlier" (for regs seeded straight into Firestore).
  seedSession({ id, pi, rid = '', amount = 3800, paid = false, last4 = '4242' } = {}) {
    const sid = id || ('cs_test_' + (++state.ids.cs));
    const intent = newIntent({ id: pi, amount, metadata: rid ? { rid } : {} });
    const s = { id: sid, object: 'checkout.session', mode: 'payment', status: 'open', payment_status: 'unpaid', amount_total: amount, currency: 'usd', url: `https://checkout.stripe.com/c/pay/${sid}`, payment_intent: intent.id, customer_email: null, client_reference_id: rid || null, metadata: rid ? { rid } : {}, success_url: `${process.env.SITE_URL}/register-success.html?rid=${rid}&provider=stripe`, cancel_url: `${process.env.SITE_URL}/register.html`, expires_at: null, line_item_name: '' };
    state.stripe.sessions.set(sid, s);
    if (paid) stripe.pay(sid, { last4 });
    return s;
  },
};

// Run fn with `new Date()` / Date.now() pinned to `iso` (explicit-argument constructors untouched).
// Needed for api/remind.js, whose handler reads the real clock to decide "tomorrow".
export async function withNow(iso, fn) {
  const fixed = RealDate.parse(iso);
  if (!Number.isFinite(fixed)) throw new Error('withNow: bad date ' + iso);
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(fixed); }
    static now() { return fixed; }
  }
  globalThis.Date = FakeDate;
  try { return await fn(); } finally { globalThis.Date = RealDate; }
}
