// Shared SendGrid sender (fetch-based, no SDK) — mirrors the STS/Plumlee pattern.
// Used for DBA's OWN branded emails: the registration receipt, refund receipt, and the
// day-before reminder. (Stripe's own customer emails are deliberately OFF — this IS the receipt.)
//
// Env: SENDGRID_API_KEY, MAIL_FROM (a domain-authenticated sender, e.g. noreply@greggdownerbasketball.com),
//      MAIL_FROM_NAME (optional), ADMIN_EMAIL (optional — BCC'd a copy),
//      MAIL_REPLY_TO (optional — where "reply to this email" actually goes; defaults to aceshoops@gmail.com).

import { priceBreakdown, sessionLabels } from './_clinic.js';

function fmtDate(iso) {
  if (!iso) return '';
  try { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' }); } catch (e) { return ''; }
}
// Plain-text fallback for the HTML body: strip tags AND decode the entities we use, so a
// text-only client never sees "&ndash;" or "&#127936;" literally.
function htmlToText(html) {
  const ents = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&ndash;': '–', '&mdash;': '—', '&middot;': '·', '&times;': '×', '&hellip;': '…' };
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch (e) { return ''; } })
    .replace(/&[a-z]+;/gi, (m) => (m in ents ? ents[m] : ''))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

const SG_KEY = process.env.SENDGRID_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || '';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'Downer Basketball Academy';
const MAIL_REPLY_TO = process.env.MAIL_REPLY_TO || 'aceshoops@gmail.com';
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';

export function emailConfigured() { return !!(SG_KEY && MAIL_FROM); }

// Returns true if SendGrid accepted the message, false otherwise. Never throws —
// a failed confirmation email must not fail the payment confirmation.
export async function sendMail({ to, subject, html, text, bcc }) {
  if (!emailConfigured() || !to) return false;
  const personalization = { to: [{ email: to }] };
  const bccList = [].concat(bcc || []).filter(Boolean).filter((e) => e !== to);
  if (bccList.length) personalization.bcc = bccList.map((e) => ({ email: e }));
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SG_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [personalization],
        from: { email: MAIL_FROM, name: MAIL_FROM_NAME },
        reply_to: { email: MAIL_REPLY_TO, name: MAIL_FROM_NAME },
        subject: subject || 'Downer Basketball Academy',
        content: [
          { type: 'text/plain', value: text || htmlToText(html) },
          ...(html ? [{ type: 'text/html', value: html }] : []),
        ],
      }),
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

// Branded "you're registered" confirmation for a paid clinic registration.
export function buildConfirmationEmail(reg) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const money = (c) => '$' + ((c || 0) / 100).toFixed(2);
  const b = priceBreakdown(reg);
  const title = esc(reg.clinic_title || 'DBA Fall Clinics');
  const regId = esc(reg.id || '');
  const dateStr = esc(fmtDate(reg.paid_at || reg.created));
  const parent = esc(reg.parent_name || '');
  const players = (reg.players || []).map((p) => esc(`${p.first} ${p.last}`.trim())).filter(Boolean);
  const labels = sessionLabels(reg).map(esc);
  const sessionsHtml = reg.all_six
    ? 'All 6 Sundays' + (labels.length ? '<br><span style="color:#888;font-size:13px">' + labels.join(' &middot; ') + '</span>' : '')
    : (labels.length ? labels.join('<br>') : ((parseInt(reg.session_count, 10) || 0) + ' session(s)'));
  const last4 = esc(reg.card_last4 || '');
  const via = esc(reg.paid_via || 'Card');
  const signer = esc(reg.waiver_name || '');
  const signedAt = esc(fmtDate(reg.waiver_at));
  const baseLabel = b.all_six ? ('All 6 sessions' + (b.player_count > 1 ? ' &times; ' + b.player_count : '')) : (b.session_count + ' session' + (b.session_count > 1 ? 's' : '') + (b.player_count > 1 ? ' &times; ' + b.player_count + ' players' : ''));

  const row = (k, v, opts) => `<tr><td style="padding:9px 14px;color:#777;border-top:1px solid #eee;vertical-align:top;white-space:nowrap">${k}</td><td style="padding:9px 14px;border-top:1px solid #eee;text-align:right${opts && opts.strong ? ';font-weight:700' : ''}">${v}</td></tr>`;

  const subject = `You're registered — ${reg.clinic_title || 'DBA Fall Clinics'}`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#222">
      <div style="background:#8B1A2B;color:#fff;padding:22px 24px;border-radius:12px 12px 0 0">
        <div style="font-weight:800;letter-spacing:3px;font-size:20px">DOWNER BASKETBALL ACADEMY</div>
        <div style="color:#f0d0d6;font-size:12px;letter-spacing:1px;margin-top:2px">REGISTRATION RECEIPT</div>
      </div>
      <div style="border:1px solid #eee;border-top:none;padding:24px;border-radius:0 0 12px 12px">
        <h2 style="margin:0 0 6px">You're registered! &#127936;</h2>
        <p style="color:#555;line-height:1.6;margin:0 0 18px">Thanks for registering for the <strong>${title}</strong>. Keep this receipt for your records.</p>

        <table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:8px;overflow:hidden;font-size:14px">
          <tr><td style="padding:9px 14px;color:#777;white-space:nowrap">Receipt #</td><td style="padding:9px 14px;text-align:right;font-family:monospace">${regId}</td></tr>
          ${dateStr ? row('Date', dateStr) : ''}
          ${parent ? row('Registrant', parent) : ''}
          ${row('Player(s)', players.length ? players.join('<br>') : '&mdash;')}
          ${row('Sessions', sessionsHtml)}
        </table>

        <table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:8px;overflow:hidden;font-size:14px;margin-top:14px">
          ${row(baseLabel, money(b.base_cents))}
          ${row('Processing', money(b.fee_cents))}
          ${row('Total paid', money(reg.amount_cents), { strong: true })}
          ${last4 ? row('Paid with', 'Card ending ' + last4 + ' (via ' + via + ')') : row('Paid with', via)}
        </table>

        <p style="color:#555;line-height:1.6;font-size:13px;margin:16px 0 0">
          <strong>Waiver &amp; refund policy:</strong> Agreed${signer ? ' &mdash; signed by ' + signer : ''}${signedAt ? ' on ' + signedAt : ''}.
          Injury or withdrawal: credit toward a future DBA clinic. If DBA cancels a session: credit or refund for that session. The card-processing fee is non-refundable.
          Full policy: <a href="https://www.greggdownerbasketball.com/policies.html#refunds" style="color:#8B1A2B">greggdownerbasketball.com/policies</a>.
        </p>

        <hr style="border:none;border-top:1px solid #eee;margin:18px 0">
        <p style="color:#555;line-height:1.6;margin:0 0 8px"><strong>Location:</strong> Kobe Bryant Gymnasium, Lower Merion HS, 315 E. Montgomery Ave, Ardmore, PA 19003.<br><strong>Parking:</strong> the lot right by the gymnasium.<br><strong>Time:</strong> Sundays, 11:00 AM &ndash; 12:15 PM. Please arrive about 10 minutes early and check in with our staff at the gym door.<br><strong>Pick-up:</strong> players are released to a parent or the authorized pickup person on this registration.<br><strong>Bring:</strong> sneakers, athletic clothes, and a water bottle. Basketballs provided.<br><strong>Cancellations:</strong> if weather or a gym closure ever forces us to cancel a Sunday, we'll email you right away and that session is credited or refunded.</p>
        <p style="color:#999;font-size:12px;line-height:1.6;margin:14px 0 0">This email is your receipt. Payments are collected by Always Competing Sports LLC on behalf of the clinic's organizing booster club and remitted to them. Questions? Reply to this email or contact aceshoops@gmail.com.</p>
      </div>
    </div>`;
  return { subject, html };
}

// Branded refund receipt — emailed to the parent when a refund is issued.
// refundedNowCents = amount refunded in THIS action; fullyRefunded flags a full refund.
export function buildRefundEmail(reg, refundedNowCents, fullyRefunded) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const money = (c) => '$' + ((c || 0) / 100).toFixed(2);
  const title = esc(reg.clinic_title || 'DBA Fall Clinics');
  const regId = esc(reg.id || '');
  const players = (reg.players || []).map((p) => esc(`${p.first} ${p.last}`.trim())).filter(Boolean);
  const via = esc(reg.paid_via || 'card');
  const last4 = esc(reg.card_last4 || '');
  const totalRefunded = reg.amount_refunded_cents || refundedNowCents || 0;
  const paidTotal = reg.amount_cents || 0;

  const row = (k, v, opts) => `<tr><td style="padding:9px 14px;color:#777;border-top:1px solid #eee;vertical-align:top;white-space:nowrap">${k}</td><td style="padding:9px 14px;border-top:1px solid #eee;text-align:right${opts && opts.strong ? ';font-weight:700' : ''}">${v}</td></tr>`;

  const subject = `Refund processed — ${reg.clinic_title || 'DBA Fall Clinics'}`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#222">
      <div style="background:#8B1A2B;color:#fff;padding:22px 24px;border-radius:12px 12px 0 0">
        <div style="font-weight:800;letter-spacing:3px;font-size:20px">DOWNER BASKETBALL ACADEMY</div>
        <div style="color:#f0d0d6;font-size:12px;letter-spacing:1px;margin-top:2px">REFUND RECEIPT</div>
      </div>
      <div style="border:1px solid #eee;border-top:none;padding:24px;border-radius:0 0 12px 12px">
        <h2 style="margin:0 0 6px">Your refund has been processed</h2>
        <p style="color:#555;line-height:1.6;margin:0 0 18px">We've refunded your payment for the <strong>${title}</strong>. It should appear on your original payment method within <strong>5&ndash;10 business days</strong>.</p>

        <table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:8px;overflow:hidden;font-size:14px">
          <tr><td style="padding:9px 14px;color:#777;white-space:nowrap">Receipt #</td><td style="padding:9px 14px;text-align:right;font-family:monospace">${regId}</td></tr>
          ${row('Player(s)', players.length ? players.join('<br>') : '&mdash;')}
          ${row('Refund amount', money(refundedNowCents), { strong: true })}
          ${last4 ? row('Refunded to', 'Card ending ' + last4 + ' (your original payment method)') : row('Refunded to', 'Your original payment method')}
          ${!fullyRefunded ? row('Note', 'Partial refund &mdash; ' + money(totalRefunded) + ' of ' + money(paidTotal) + ' refunded to date') : ''}
        </table>

        <p style="color:#999;font-size:12px;line-height:1.6;margin:16px 0 0">Payments are collected by Always Competing Sports LLC on behalf of the clinic's organizing booster club and remitted to them. Questions about your refund? Reply to this email or contact aceshoops@gmail.com.</p>
      </div>
    </div>`;
  return { subject, html };
}

// Branded "see you tomorrow" reminder for ONE clinic session (sent by api/remind.js
// the day before). `session` is an entry from SESSIONS in _clinic.js.
export function buildReminderEmail(reg, session) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const when = esc(session && session.label ? session.label.replace(/^Session \d+ — /, '') : 'tomorrow');
  const players = (reg.players || []).map((p) => esc(`${p.first} ${p.last}`.trim())).filter(Boolean);
  const who = players.length ? players.join(' & ') : 'your player';
  const cell = (k, v, top) => `<tr><td style="padding:9px 14px;color:#777;white-space:nowrap${top ? ';border-top:1px solid #eee' : ''}">${k}</td><td style="padding:9px 14px;text-align:right${top ? ';border-top:1px solid #eee' : ''}">${v}</td></tr>`;

  const subject = `Reminder: clinic tomorrow — ${when}, 11:00 AM`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#222">
      <div style="background:#8B1A2B;color:#fff;padding:22px 24px;border-radius:12px 12px 0 0">
        <div style="font-weight:800;letter-spacing:3px;font-size:20px">DOWNER BASKETBALL ACADEMY</div>
        <div style="color:#f0d0d6;font-size:12px;letter-spacing:1px;margin-top:2px">SESSION REMINDER</div>
      </div>
      <div style="border:1px solid #eee;border-top:none;padding:24px;border-radius:0 0 12px 12px">
        <h2 style="margin:0 0 6px">See you tomorrow! &#127936;</h2>
        <p style="color:#555;line-height:1.6;margin:0 0 18px">Quick reminder that <strong>${who}</strong> ${players.length > 1 ? 'are' : 'is'} signed up for the Fall Clinic on <strong>${when}</strong>.</p>
        <table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:8px;overflow:hidden;font-size:14px">
          ${cell('When', when + ' &middot; 11:00 AM &ndash; 12:15 PM', false)}
          ${cell('Where', 'Kobe Bryant Gymnasium, Lower Merion HS<br><span style="color:#777">315 E. Montgomery Ave, Ardmore, PA 19003</span>', true)}
          ${cell('Parking', 'The lot right by the gymnasium', true)}
          ${cell('Bring', 'Sneakers, athletic clothes, and a water bottle', true)}
        </table>
        <p style="color:#555;line-height:1.6;font-size:13px;margin:16px 0 0">Please arrive about 10 minutes early and check in with our staff at the gym door. Players are released to a parent or your authorized pickup person. Can't make it? Just reply to this email or contact aceshoops@gmail.com.</p>
        <p style="color:#999;font-size:12px;line-height:1.6;margin:14px 0 0">Downer Basketball Academy &middot; Fall Clinics 2026</p>
      </div>
    </div>`;
  return { subject, html };
}

// Session notice / cancellation for ONE Sunday, sent to every registered family via sendBulk.
// The greeting uses the SendGrid substitution tag -parent- (each family's first name).
export function buildNoticeEmail(session, opts) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const o = opts || {};
  const cancel = !!o.cancel;
  const when = session && session.label ? session.label.replace(/^Session \d+ — /, '') : '';
  const subject = String(o.subject || '').trim().slice(0, 200) || (cancel ? `Clinic cancelled — ${when}` : `Fall Clinics update — ${when}`);
  const message = String(o.message || '').trim();
  const body = esc(message).replace(/\r?\n/g, '<br>');
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#222">
      <div style="background:#8B1A2B;color:#fff;padding:22px 24px;border-radius:12px 12px 0 0">
        <div style="font-weight:800;letter-spacing:3px;font-size:20px">DOWNER BASKETBALL ACADEMY</div>
        <div style="color:#f0d0d6;font-size:12px;letter-spacing:1px;margin-top:2px">${cancel ? 'SESSION CANCELLED' : 'CLINIC UPDATE'}</div>
      </div>
      <div style="border:1px solid #eee;border-top:none;padding:24px;border-radius:0 0 12px 12px">
        ${cancel ? `<div style="background:#fdecec;border:1px solid #f3b4b4;color:#8B1A2B;border-radius:8px;padding:10px 14px;font-weight:700;margin:0 0 16px">The ${esc(when)} clinic is cancelled</div>` : ''}
        <p style="color:#222;line-height:1.6;margin:0 0 12px">Hi -parent-,</p>
        <p style="color:#333;line-height:1.7;margin:0 0 16px">${body}</p>
        <p style="color:#999;font-size:12px;line-height:1.6;margin:18px 0 0">Questions? Reply to this email or contact aceshoops@gmail.com. &middot; <a href="https://www.greggdownerbasketball.com/policies.html#refunds" style="color:#999">Refund &amp; cancellation policy</a><br>Downer Basketball Academy &middot; Fall Clinics 2026</p>
      </div>
    </div>`;
  const text = `Hi -parent-,\n\n${cancel ? `The ${when} clinic is cancelled.\n\n` : ''}${message}\n\nQuestions? Reply to this email or contact aceshoops@gmail.com.\nDowner Basketball Academy · Fall Clinics 2026`;
  return { subject, html, text };
}

// Send ONE message to many families in a single SendGrid call (500 per call), with a per-family
// greeting via substitution. Used for session notices so a whole roster is one request, not one
// request per family (which would risk the function's time limit).
export async function sendBulk({ recipients, subject, html, text, bcc }) {
  const list = (recipients || []).filter((r) => r && r.email);
  if (!emailConfigured()) return { sent: 0, failed: list.length, error: 'email_not_configured' };
  const clean = (n) => String(n || 'there').replace(/[<>&"]/g, '').slice(0, 60);
  const extra = [].concat(bcc || []).filter(Boolean).filter((e) => !list.some((r) => r.email === e)).map((e) => ({ email: e, name: 'Parent' }));
  const all = list.concat(extra);
  let sent = 0, failed = 0, error = '';
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500);
    try {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${SG_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: chunk.map((p) => ({ to: [{ email: p.email }], substitutions: { '-parent-': clean(p.name) } })),
          from: { email: MAIL_FROM, name: MAIL_FROM_NAME },
          reply_to: { email: MAIL_REPLY_TO, name: MAIL_FROM_NAME },
          subject: subject || 'Downer Basketball Academy',
          content: [
            { type: 'text/plain', value: text || htmlToText(html) },
            ...(html ? [{ type: 'text/html', value: html }] : []),
          ],
        }),
      });
      if (r.ok) sent += chunk.length; else { failed += chunk.length; error = 'sendgrid http ' + r.status; }
    } catch (e) { failed += chunk.length; error = String((e && e.message) || e); }
  }
  return { sent, failed, error };
}
