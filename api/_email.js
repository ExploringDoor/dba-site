// Shared SendGrid sender (fetch-based, no SDK) — mirrors the STS/Plumlee pattern.
// Used for DBA's OWN branded emails (e.g. the registration confirmation). The
// official card RECEIPT is emailed automatically by Stripe/Square, not here.
//
// Env: SENDGRID_API_KEY, MAIL_FROM (a SendGrid-verified sender address),
//      MAIL_FROM_NAME (optional), ADMIN_EMAIL (optional — BCC'd a copy).

import { priceBreakdown, sessionLabels } from './_clinic.js';

function fmtDate(iso) {
  if (!iso) return '';
  try { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); } catch (e) { return ''; }
}

const SG_KEY = process.env.SENDGRID_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || '';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'Downer Basketball Academy';
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
        subject: subject || 'Downer Basketball Academy',
        content: [
          { type: 'text/plain', value: text || (html ? html.replace(/<[^>]+>/g, ' ') : '') },
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
          ${last4 ? row('Paid with', via + ' ending ' + last4) : row('Paid with', via)}
        </table>

        <p style="color:#555;line-height:1.6;font-size:13px;margin:16px 0 0">
          <strong>Waiver &amp; refund policy:</strong> Agreed${signer ? ' &mdash; signed by ' + signer : ''}${signedAt ? ' on ' + signedAt : ''}.
          Refunds are issued as credit toward a future clinic for injury or withdrawal &mdash; contact us.
        </p>

        <hr style="border:none;border-top:1px solid #eee;margin:18px 0">
        <p style="color:#555;line-height:1.6;margin:0 0 8px"><strong>Location:</strong> Kobe Bryant Gymnasium, Lower Merion HS, 315 E. Montgomery Ave, Ardmore, PA 19003.<br><strong>Time:</strong> Sundays, 11:00 AM &ndash; 12:15 PM.<br><strong>Bring:</strong> sneakers, athletic clothes, and a water bottle. Basketballs provided.</p>
        <p style="color:#999;font-size:12px;line-height:1.6;margin:14px 0 0">Your card processor also emails an official payment receipt. Questions? Reply to this email or contact aceshoops@gmail.com.</p>
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
          ${last4 ? row('Refunded to', via + ' ending ' + last4) : row('Refunded to', 'your original ' + via)}
          ${!fullyRefunded ? row('Note', 'Partial refund &mdash; ' + money(totalRefunded) + ' of ' + money(paidTotal) + ' refunded to date') : ''}
        </table>

        <p style="color:#999;font-size:12px;line-height:1.6;margin:16px 0 0">Questions about your refund? Reply to this email or contact aceshoops@gmail.com.</p>
      </div>
    </div>`;
  return { subject, html };
}
