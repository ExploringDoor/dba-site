// Shared SendGrid sender (fetch-based, no SDK) — mirrors the STS/Plumlee pattern.
// Used for DBA's OWN branded emails (e.g. the registration confirmation). The
// official card RECEIPT is emailed automatically by Stripe/Square, not here.
//
// Env: SENDGRID_API_KEY, MAIL_FROM (a SendGrid-verified sender address),
//      MAIL_FROM_NAME (optional), ADMIN_EMAIL (optional — BCC'd a copy).

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
  const title = esc(reg.clinic_title || 'DBA Fall Clinics');
  const players = esc((reg.players || []).map((p) => `${p.first} ${p.last}`.trim()).filter(Boolean).join(', '));
  const sessions = reg.all_six ? 'All 6 sessions' : `${(parseInt(reg.session_count, 10) || 0)} session${reg.session_count > 1 ? 's' : ''}`;
  const amount = ((reg.amount_cents || 0) / 100).toFixed(2);
  const subject = `You're registered — ${reg.clinic_title || 'DBA Fall Clinics'} 🏀`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#222">
      <div style="background:#8B1A2B;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0">
        <div style="font-weight:800;letter-spacing:3px;font-size:20px">DOWNER BASKETBALL ACADEMY</div>
      </div>
      <div style="border:1px solid #eee;border-top:none;padding:24px;border-radius:0 0 12px 12px">
        <h2 style="margin:0 0 8px">You're all set! 🏀</h2>
        <p style="color:#555;line-height:1.6">Thanks for registering for the <strong>${title}</strong>. Here are your details:</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:8px 0;color:#888">Player(s)</td><td style="padding:8px 0;text-align:right"><strong>${players || '—'}</strong></td></tr>
          <tr><td style="padding:8px 0;color:#888;border-top:1px solid #eee">Sessions</td><td style="padding:8px 0;text-align:right;border-top:1px solid #eee">${sessions}</td></tr>
          <tr><td style="padding:8px 0;color:#888;border-top:1px solid #eee">Total paid</td><td style="padding:8px 0;text-align:right;border-top:1px solid #eee"><strong>$${amount}</strong></td></tr>
        </table>
        <p style="color:#555;line-height:1.6"><strong>Location:</strong> Kobe Bryant Gymnasium, Lower Merion HS, 315 E. Montgomery Ave, Ardmore, PA 19003.<br><strong>Time:</strong> Sundays, 11:00 AM – 12:15 PM.</p>
        <p style="color:#555;line-height:1.6"><strong>What to bring:</strong> sneakers, athletic clothes, and a water bottle. Basketballs provided.</p>
        <p style="color:#888;font-size:13px;line-height:1.6">A separate payment receipt has been emailed by our card processor. Questions? Just reply to this email or contact aceshoops@gmail.com.</p>
      </div>
    </div>`;
  return { subject, html };
}
