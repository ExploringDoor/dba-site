#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// One-time launch announcement to past clinic parents. Runs LOCALLY — never
// deployed, and the list/key are gitignored so they never reach GitHub or the web.
//
//   node scripts/send-launch-email.mjs                 DRY RUN — parses the list, shows the
//                                                      count + a masked sample, sends NOTHING
//   node scripts/send-launch-email.mjs --test you@x.com  sends ONE real email to that address
//                                                      (preview it in your own inbox first)
//   node scripts/send-launch-email.mjs --send          sends to everyone on the list
//
// Inputs (all gitignored):
//   scripts/launch-list.csv   the RYZER export — any CSV with an "email" column; a first-name
//                             column is used for "Hi <name>," when present
//   .env.local                SENDGRID_API_KEY=…   MAIL_ADDRESS=…   (MAIL_FROM defaults to
//                             noreply@greggdownerbasketball.com — the SendGrid-verified sender)
// ─────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST = path.join(ROOT, 'scripts', 'launch-list.csv');
const ENV = path.join(ROOT, '.env.local');
const LOG = path.join(ROOT, 'scripts', `launch-send-${new Date().toISOString().slice(0, 10)}.log`);

// Tiny .env loader (no dependencies). Real env vars win over the file.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv(ENV);

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const ti = args.indexOf('--test');
const TEST_TO = ti >= 0 ? String(args[ti + 1] || '') : '';

const KEY = process.env.SENDGRID_API_KEY || '';
const FROM = process.env.MAIL_FROM || 'noreply@greggdownerbasketball.com';
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Lower Merion Basketball Academy';
const REPLY_TO = process.env.MAIL_REPLY_TO || 'aceshoops@gmail.com'; // so "reply unsubscribe" reaches a real inbox
const ADDRESS = process.env.MAIL_ADDRESS || '';                       // required by CAN-SPAM for a marketing email
const REGISTER = 'https://www.greggdownerbasketball.com/clinics.html#register';

// ── CSV (quote-aware) ───────────────────────────────────────────────────
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip a leading BOM so column 1 isn't prefixed
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

function loadRecipients() {
  if (!fs.existsSync(LIST)) throw new Error(`List not found: ${LIST}\n→ Drag the RYZER export into the dba-site/scripts folder and name it launch-list.csv`);
  const rows = parseCSV(fs.readFileSync(LIST, 'utf8'));
  if (rows.length < 2) throw new Error('The CSV has a header but no data rows.');
  const header = rows[0].map((h) => String(h).replace(/^﻿/, '').trim().toLowerCase());
  const ei = header.findIndex((h) => h.includes('email'));
  if (ei < 0) throw new Error(`No "email" column found. Columns are: ${rows[0].join(' | ')}`);
  // best-effort first name: a column literally called first name, else a parent/guardian name column
  let fi = header.findIndex((h) => /first/.test(h) && /name/.test(h));
  if (fi < 0) fi = header.findIndex((h) => /(parent|guardian).*name|^name$/.test(h));
  const seen = new Set(); const recipients = [];
  for (const r of rows.slice(1)) {
    const email = String(r[ei] || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || seen.has(email)) continue; // skip blanks, junk, dupes
    seen.add(email);
    const first = fi >= 0 ? String(r[fi] || '').trim().split(/\s+/)[0].replace(/[^A-Za-z'\-]/g, '') : '';
    recipients.push({ email, first });
  }
  return { recipients, columns: rows[0], rawRows: rows.length - 1, nameColumn: fi >= 0 ? rows[0][fi] : null };
}

const mask = (e) => e.replace(/^(.)[^@]*(@.*)$/, '$1***$2');

// ── The email (copy approved by Adam) ───────────────────────────────────
function build(first) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const hi = first ? `Hi ${esc(first)},` : 'Hi there,';
  const subject = 'Fall Clinics are back — six Sundays at the Kobe Bryant Gym 🏀';
  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#222;line-height:1.6">
  <div style="background:#8B1A2B;color:#fff;padding:22px 24px;border-radius:12px 12px 0 0">
    <div style="font-weight:800;letter-spacing:3px;font-size:20px">FALL CLINICS 2026</div>
    <div style="color:#f0d0d6;font-size:12px;letter-spacing:1px;margin-top:2px">SIX SUNDAYS &middot; KOBE BRYANT GYMNASIUM</div>
  </div>
  <div style="border:1px solid #eee;border-top:none;padding:24px;border-radius:0 0 12px 12px">
    <p style="margin:0 0 14px">${hi}</p>
    <p style="margin:0 0 14px"><strong>Registration is open for Lower Merion Basketball Academy Fall Clinics</strong> &mdash; six Sunday skill sessions this fall on the same court where Kobe built his game.</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:8px;overflow:hidden;font-size:14px;margin:0 0 16px">
      <tr><td style="padding:9px 14px;color:#777;white-space:nowrap">Six Sundays</td><td style="padding:9px 14px">Sep 27, Oct 4, 11, 18, 25 &amp; Nov 1</td></tr>
      <tr><td style="padding:9px 14px;color:#777;border-top:1px solid #eee">Time</td><td style="padding:9px 14px;border-top:1px solid #eee">11:00 AM &ndash; 12:15 PM</td></tr>
      <tr><td style="padding:9px 14px;color:#777;border-top:1px solid #eee">Who</td><td style="padding:9px 14px;border-top:1px solid #eee">Boys &amp; girls, ages 6&ndash;14 &mdash; all levels welcome</td></tr>
      <tr><td style="padding:9px 14px;color:#777;border-top:1px solid #eee">Where</td><td style="padding:9px 14px;border-top:1px solid #eee">Kobe Bryant Gymnasium, Lower Merion HS, Ardmore, PA<br><span style="color:#777">Park in the lot by the gym</span></td></tr>
      <tr><td style="padding:9px 14px;color:#777;border-top:1px solid #eee">Price</td><td style="padding:9px 14px;border-top:1px solid #eee"><strong>$30</strong> per session, or <strong>$150</strong> for all six</td></tr>
    </table>
    <p style="margin:0 0 14px">Every session: warm-up and fundamentals, skill stations by age and level, then competitive games &mdash; every player touches the ball, every week.</p>
    <p style="margin:0 0 18px">Our clinics sell out every year, so grab your player's spot early:</p>
    <p style="text-align:center;margin:0 0 22px"><a href="${REGISTER}" style="display:inline-block;background:#8B1A2B;color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:10px">Register Now &rarr;</a></p>
    <p style="margin:0">See you on the court!<br><strong>Lower Merion Basketball Academy</strong></p>
    <hr style="border:none;border-top:1px solid #eee;margin:20px 0 12px">
    <p style="color:#999;font-size:11px;line-height:1.5;margin:0">Reply &ldquo;unsubscribe&rdquo; to opt out &middot; Lower Merion Basketball Academy${ADDRESS ? ' &middot; ' + esc(ADDRESS) : ''}</p>
  </div>
</div>`;
  const text = `${first ? `Hi ${first},` : 'Hi there,'}

Registration is open for Lower Merion Basketball Academy Fall Clinics — six Sunday skill sessions this fall on the same court where Kobe built his game.

Six Sundays: Sep 27, Oct 4, 11, 18, 25 & Nov 1
Time: 11:00 AM – 12:15 PM
Who: Boys & girls, ages 6–14 — all levels welcome
Where: Kobe Bryant Gymnasium, Lower Merion HS, Ardmore, PA (park in the lot by the gym)
Price: $30 per session, or $150 for all six

Every session: warm-up and fundamentals, skill stations by age and level, then competitive games — every player touches the ball, every week.

Our clinics sell out every year, so grab your player's spot early:
${REGISTER}

See you on the court!
Lower Merion Basketball Academy

--
Reply "unsubscribe" to opt out · Lower Merion Basketball Academy${ADDRESS ? ' · ' + ADDRESS : ''}`;
  return { subject, html, text };
}

// ── SendGrid (one personal email per recipient) ─────────────────────────
async function sendOne(to, first) {
  const { subject, html, text } = build(first);
  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM, name: FROM_NAME },
      reply_to: { email: REPLY_TO },
      subject,
      content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }],
      tracking_settings: { click_tracking: { enable: false }, open_tracking: { enable: false } },
    }),
  });
  return r.ok ? '' : `HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`;
}

function requireSendPrereqs() {
  const missing = [];
  if (!KEY) missing.push('SENDGRID_API_KEY');
  if (!ADDRESS) missing.push('MAIL_ADDRESS (a mailing address is legally required on a marketing email)');
  if (missing.length) throw new Error(`Missing in .env.local: ${missing.join(', ')}`);
}

(async () => {
  try {
    if (TEST_TO) {
      requireSendPrereqs();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(TEST_TO)) throw new Error(`Not a valid email: ${TEST_TO}`);
      const err = await sendOne(TEST_TO, 'Adam');
      console.log(err ? `✗ test send failed: ${err}` : `✓ test email sent to ${TEST_TO} — check your inbox.`);
      process.exit(err ? 1 : 0);
    }

    const { recipients, columns, rawRows, nameColumn } = loadRecipients();
    console.log(`List: ${LIST}`);
    console.log(`Columns: ${columns.join(' | ')}`);
    console.log(`Rows: ${rawRows} → ${recipients.length} unique valid emails${nameColumn ? ` (first names from "${nameColumn}")` : ' (no name column — will say "Hi there,")'}`);
    console.log(`Sample: ${recipients.slice(0, 5).map((r) => mask(r.email) + (r.first ? ` (${r.first})` : '')).join(', ')}`);

    if (!SEND) { console.log('\nDRY RUN — nothing sent. Preview one with --test you@example.com, then send with --send.'); return; }

    requireSendPrereqs();
    console.log(`\nSending ${recipients.length} emails from "${FROM_NAME}" <${FROM}> (reply-to ${REPLY_TO})…`);
    const log = fs.createWriteStream(LOG, { flags: 'a' });
    let ok = 0, bad = 0;
    for (const [i, r] of recipients.entries()) {
      const err = await sendOne(r.email, r.first);
      if (err) { bad++; log.write(`FAIL ${r.email} ${err}\n`); } else { ok++; log.write(`SENT ${r.email}\n`); }
      if ((i + 1) % 25 === 0) console.log(`  …${i + 1}/${recipients.length}`);
      await new Promise((res) => setTimeout(res, 120)); // gentle pacing
    }
    log.end();
    console.log(`\nDone: ${ok} sent, ${bad} failed. Log: ${LOG}`);
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exit(1);
  }
})();
