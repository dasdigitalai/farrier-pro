// /api/send-email.js
// Unified email handler for FarriTech.
// Pass action: 'confirmation' | 'cancellation' | 'update' | 'route-sheet'
// Route-sheet uses: { action, to, subject, html }
// Appointment emails use the same body fields as the individual handlers did.

import { authorizeSender } from './_lib/firebase-rest.js';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = 'FarriTech <welcome@contact.dasdigitalai.com>';

const sendEmail = async ({ to, subject, html, replyTo }) => {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Resend API error');
  return data;
};

const formatTime = (t) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
};

const footer = `
  <div style="background:#f9fafb;padding:20px 30px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;text-align:center;">
    <p style="color:#9ca3af;font-size:12px;margin:0;">Powered by <a href="https://www.farritech.com" style="color:#6b7280;text-decoration:none;">FarriTech</a> &nbsp;·&nbsp; <a href="https://www.farritech.com" style="color:#9ca3af;text-decoration:none;">www.farritech.com</a></p>
  </div>`;

// ── CONFIRMATION ────────────────────────────────────────────────────────────
function buildConfirmationHtml(body) {
  const { customerName, farmName, farrierBusinessName, farrierEmail, farrierPhone,
    services, numberOfHorses, requestedDate, requestedTime, address, city, state, zip, comments } = body;
  const bizName = farrierBusinessName || 'Your Farrier Service';
  const servicesList = Array.isArray(services) ? services.join(', ') : (services || 'Not specified');
  const fullAddress = [address, city, state, zip].filter(Boolean).join(', ') || 'Not provided';
  const displayTime = formatTime(requestedTime);
  const firstName = customerName?.split(' ')[0] || 'there';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;">
  <div style="text-align:center;padding:30px;background:linear-gradient(135deg,#1a365d 0%,#2563eb 100%);border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:28px;font-weight:700;">🐴 ${bizName}</h1>
    <p style="color:#06b6d4;margin:8px 0 0;font-size:15px;font-weight:600;">✅ Appointment Confirmed!</p>
  </div>
  <div style="background:#fff;padding:35px 30px;border:1px solid #e5e7eb;border-top:none;">
    <h2 style="color:#1a365d;margin-top:0;">Great news, ${firstName}! 🎉</h2>
    <p style="color:#4b5563;font-size:15px;">Your appointment with <strong>${bizName}</strong> has been <strong>confirmed</strong>. We look forward to seeing you!</p>
    <div style="background:#f0fdf4;border:2px solid #10b981;padding:24px;margin:24px 0;border-radius:8px;">
      <h3 style="color:#065f46;margin-top:0;font-size:17px;">📅 Your Confirmed Appointment</h3>
      <table style="width:100%;border-collapse:collapse;font-size:15px;color:#374151;">
        <tr><td style="padding:6px 0;width:140px;color:#6b7280;vertical-align:top;">Date</td><td><strong>${requestedDate || '—'}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;vertical-align:top;">Time</td><td><strong>${displayTime}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;vertical-align:top;">Services</td><td>${servicesList}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;vertical-align:top;">Horses</td><td>${numberOfHorses || '—'}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;vertical-align:top;">Location</td><td>${fullAddress}</td></tr>
        ${farmName ? `<tr><td style="padding:6px 0;color:#6b7280;vertical-align:top;">Farm / Business</td><td>${farmName}</td></tr>` : ''}
        ${comments ? `<tr><td style="padding:6px 0;color:#6b7280;vertical-align:top;">Notes</td><td>${comments}</td></tr>` : ''}
      </table>
    </div>
    <div style="background:#f0f9ff;border-left:4px solid #2563eb;padding:18px 20px;margin:20px 0;border-radius:4px;">
      <h3 style="color:#1a365d;margin-top:0;font-size:15px;">📞 Need to make changes?</h3>
      <p style="margin:0;color:#4b5563;font-size:14px;">Contact <strong>${bizName}</strong> directly:</p>
      ${farrierPhone ? `<p style="margin:6px 0 0;color:#4b5563;font-size:14px;">📱 ${farrierPhone}</p>` : ''}
      ${farrierEmail ? `<p style="margin:4px 0 0;font-size:14px;"><a href="mailto:${farrierEmail}" style="color:#2563eb;text-decoration:none;">✉️ ${farrierEmail}</a></p>` : ''}
      <p style="margin:8px 0 0;color:#6b7280;font-size:13px;">Or simply reply to this email.</p>
    </div>
  </div>${footer}</body></html>`;
}

// ── CANCELLATION ─────────────────────────────────────────────────────────────
function buildCancellationHtml(body) {
  const { customerName, farmName, farrierBusinessName, farrierEmail, farrierPhone,
    requestedDate, requestedTime, services, bookingUrl } = body;
  const bizName = farrierBusinessName || 'Your Farrier Service';
  const servicesList = Array.isArray(services) ? services.join(', ') : (services || 'Not specified');
  const displayTime = formatTime(requestedTime);
  const firstName = customerName?.split(' ')[0] || 'there';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;">
  <div style="text-align:center;padding:30px;background:linear-gradient(135deg,#7f1d1d 0%,#ef4444 100%);border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:28px;font-weight:700;">🐴 ${bizName}</h1>
    <p style="color:#fecaca;margin:8px 0 0;font-size:15px;font-weight:600;">Appointment Cancellation Notice</p>
  </div>
  <div style="background:#fff;padding:35px 30px;border:1px solid #e5e7eb;border-top:none;">
    <h2 style="color:#1a365d;margin-top:0;">Hi ${firstName},</h2>
    <p style="color:#4b5563;font-size:15px;">We're sorry to let you know that your appointment with <strong>${bizName}</strong> has been <strong>cancelled</strong>.</p>
    <div style="background:#fef2f2;border:2px solid #ef4444;padding:24px;margin:24px 0;border-radius:8px;">
      <h3 style="color:#991b1b;margin-top:0;font-size:17px;">✕ Cancelled Appointment</h3>
      <table style="width:100%;border-collapse:collapse;font-size:15px;color:#374151;">
        <tr><td style="padding:6px 0;width:130px;color:#6b7280;">Date</td><td><strong>${requestedDate || '—'}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Time</td><td><strong>${displayTime}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Services</td><td>${servicesList}</td></tr>
        ${farmName ? `<tr><td style="padding:6px 0;color:#6b7280;">Farm / Business</td><td>${farmName}</td></tr>` : ''}
      </table>
    </div>
    <p style="color:#4b5563;font-size:15px;">We apologize for any inconvenience. Please contact us to reschedule at your earliest convenience.</p>
    ${bookingUrl ? `<div style="text-align:center;margin:28px 0;"><a href="${bookingUrl}" style="background:linear-gradient(135deg,#2563eb 0%,#06b6d4 100%);color:#fff;padding:14px 32px;text-decoration:none;border-radius:6px;font-weight:600;display:inline-block;font-size:16px;">📅 Book a New Appointment</a></div>` : ''}
    <div style="background:#f0f9ff;border-left:4px solid #2563eb;padding:18px 20px;margin:20px 0;border-radius:4px;">
      <h3 style="color:#1a365d;margin-top:0;font-size:15px;">📞 Questions? Get in touch</h3>
      ${farrierPhone ? `<p style="margin:4px 0;color:#4b5563;font-size:14px;">📱 ${farrierPhone}</p>` : ''}
      ${farrierEmail ? `<p style="margin:4px 0;font-size:14px;"><a href="mailto:${farrierEmail}" style="color:#2563eb;text-decoration:none;">✉️ ${farrierEmail}</a></p>` : ''}
      <p style="margin:8px 0 0;color:#6b7280;font-size:13px;">Or simply reply to this email.</p>
    </div>
  </div>${footer}</body></html>`;
}

// ── UPDATE ────────────────────────────────────────────────────────────────────
function buildUpdateHtml(body) {
  const { customerName, farmName, farrierBusinessName, farrierEmail, farrierPhone,
    bookingUrl, services, numberOfHorses, requestedDate, requestedTime,
    address, city, state, zip, comments } = body;
  const bizName = farrierBusinessName || 'Your Farrier Service';
  const servicesList = Array.isArray(services) ? services.join(', ') : (services || 'Not specified');
  const fullAddress = [address, city, state, zip].filter(Boolean).join(', ') || 'Not provided';
  const displayTime = formatTime(requestedTime);
  const firstName = customerName?.split(' ')[0] || 'there';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;">
  <div style="text-align:center;padding:30px;background:linear-gradient(135deg,#1a365d 0%,#2563eb 100%);border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:28px;font-weight:700;">🐴 ${bizName}</h1>
    <p style="color:#06b6d4;margin:8px 0 0;font-size:15px;font-weight:600;">📝 Appointment Update</p>
  </div>
  <div style="background:#fff;padding:35px 30px;border:1px solid #e5e7eb;border-top:none;">
    <h2 style="color:#1a365d;margin-top:0;">Hi ${firstName},</h2>
    <p style="color:#4b5563;font-size:15px;">Your appointment with <strong>${bizName}</strong> has been updated. Please review the new details below.</p>
    <div style="background:#f0f9ff;border:2px solid #2563eb;padding:24px;margin:24px 0;border-radius:8px;">
      <h3 style="color:#1e40af;margin-top:0;font-size:17px;">📅 Updated Appointment Details</h3>
      <table style="width:100%;border-collapse:collapse;font-size:15px;color:#374151;">
        <tr><td style="padding:6px 0;width:140px;color:#6b7280;vertical-align:top;">Date</td><td><strong>${requestedDate || '—'}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;vertical-align:top;">Time</td><td><strong>${displayTime}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;vertical-align:top;">Services</td><td>${servicesList}</td></tr>
        ${numberOfHorses ? `<tr><td style="padding:6px 0;color:#6b7280;vertical-align:top;">Horses</td><td>${numberOfHorses}</td></tr>` : ''}
        <tr><td style="padding:6px 0;color:#6b7280;vertical-align:top;">Location</td><td>${fullAddress}</td></tr>
        ${farmName ? `<tr><td style="padding:6px 0;color:#6b7280;vertical-align:top;">Farm / Business</td><td>${farmName}</td></tr>` : ''}
        ${comments ? `<tr><td style="padding:6px 0;color:#6b7280;vertical-align:top;">Notes</td><td>${comments}</td></tr>` : ''}
      </table>
    </div>
    <div style="background:#f9fafb;border-left:4px solid #6b7280;padding:18px 20px;margin:20px 0;border-radius:4px;">
      <h3 style="color:#1a365d;margin-top:0;font-size:15px;">📞 Questions or need to reschedule?</h3>
      ${farrierPhone ? `<p style="margin:4px 0;color:#4b5563;font-size:14px;">📱 ${farrierPhone}</p>` : ''}
      ${farrierEmail ? `<p style="margin:4px 0;font-size:14px;"><a href="mailto:${farrierEmail}" style="color:#2563eb;text-decoration:none;">✉️ ${farrierEmail}</a></p>` : ''}
      ${bookingUrl ? `<div style="margin-top:14px;"><a href="${bookingUrl}" style="background:linear-gradient(135deg,#2563eb 0%,#06b6d4 100%);color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600;display:inline-block;font-size:14px;">📅 Book / Reschedule Online</a></div>` : ''}
    </div>
  </div>${footer}</body></html>`;
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const { action } = body;

    // Only signed-in farriers (incl. team members), FarriTech support staff, or the server
    // itself may send — otherwise anyone could send any email from FarriTech's address.
    // The public /seminar sign-up is the one exception; it only sends fixed content.
    if (action !== 'seminar-signup') {
      const auth = await authorizeSender(req, 'send-email');
      if (auth.error) return res.status(auth.status).json({ ok: false, error: auth.error });
    }

    if (!action) {
      // Direct pass-through: { to, subject, html }
      const { to, subject, html } = body;
      if (!to) return res.status(400).json({ ok: false, error: 'Missing to' });
      if (!html) return res.status(400).json({ ok: false, error: 'Missing html' });
      await sendEmail({ to, subject: subject || 'Message from FarriTech', html });
      return res.status(200).json({ ok: true });
    }

    // ── Seminar sign-up (public /seminar page) ── emails the sign-up to the FarriTech
    // owner and a confirmation to the attendee. Fixed content, fields escaped.
    if (action === 'seminar-signup') {
      if (body.website) return res.status(200).json({ ok: true }); // honeypot: bots fill it
      const esc = (v) => String(v ?? '').slice(0, 200).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const name = String(body.name || '').trim();
      const phone = String(body.phone || '').trim();
      const email = String(body.email || '').trim();
      const guests = Math.min(Math.max(parseInt(body.guests, 10) || 1, 1), 10);
      if (!name) return res.status(400).json({ ok: false, error: 'Missing name' });
      if (!phone && !email) return res.status(400).json({ ok: false, error: 'Missing phone or email' });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Invalid email' });

      const ownerTo = process.env.SEMINAR_SIGNUP_TO || process.env.STATS_EMAIL_TO || 'david@dasdigitalai.com';
      const rows = [['Name', name], ['Mobile', phone], ['Email', email], ['Business', body.business], ['Coming', String(guests)]]
        .filter(([, v]) => v).map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">${k}</td><td><strong>${esc(v)}</strong></td></tr>`).join('');
      await sendEmail({
        to: ownerTo,
        subject: `🐴 Seminar sign-up: ${name.slice(0, 80)} (${guests})`,
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:20px;color:#333;">
          <h2 style="color:#1a365d;margin:0 0 12px;">New FarriTech Seminar sign-up</h2>
          <p style="margin:0 0 12px;">Sat, Nov 14 · 9:00–10:00 am · Palm Beach Farrier Supply</p>
          <table>${rows}</table></div>`,
        replyTo: email || undefined,
      });

      if (email) {
        try {
          await sendEmail({
            to: email,
            subject: "You're signed up: FarriTech Seminar, Sat Nov 14",
            html: `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">
              <div style="text-align:center;padding:24px;background:linear-gradient(135deg,#1a365d,#2563eb);border-radius:8px 8px 0 0;">
                <h1 style="color:#fff;margin:0;font-size:24px;">🐴 FarriTech Seminar</h1>
                <p style="color:#bfdbfe;margin:6px 0 0;">Free class for farriers</p>
              </div>
              <div style="background:#fff;padding:28px;border:1px solid #e5e7eb;border-top:none;">
                <p style="font-size:16px;">Hi ${esc(name.split(' ')[0])},</p>
                <p>Thanks for signing up — we'll save you a seat${guests > 1 ? ` (${guests} people)` : ''}.</p>
                <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px 20px;margin:20px 0;">
                  <p style="margin:0 0 6px;"><strong>📅 Saturday, November 14</strong></p>
                  <p style="margin:0 0 6px;"><strong>🕘 9:00 – 10:00 am</strong></p>
                  <p style="margin:0;"><strong>📍 Palm Beach Farrier Supply</strong><br>3500 Fairlane Farms Rd, Suite 13<br>Wellington, FL 33414</p>
                </div>
                <p>Coffee, donuts and connections — and a special rate for everyone at the class. Bring your phone!</p>
              </div>${footer}</body></html>`,
          });
        } catch (e) { console.warn('Seminar confirmation email failed:', e.message); }
      }
      return res.status(200).json({ ok: true });
    }

    // ── Route sheet: pass-through (html + subject + to already built client-side) ──
    if (action === 'route-sheet') {
      const { to, subject, html } = body;
      if (!to) return res.status(400).json({ ok: false, error: 'Missing to' });
      if (!html) return res.status(400).json({ ok: false, error: 'Missing html' });
      await sendEmail({ to, subject: subject || 'Your FarriTech Route Sheet', html });
      return res.status(200).json({ ok: true });
    }

    // ── Appointment emails ────────────────────────────────────────────────────
    const { customerEmail, farrierEmail, farrierBusinessName, requestedDate } = body;
    if (!customerEmail) return res.status(400).json({ ok: false, error: 'Missing customerEmail' });

    const bizName = farrierBusinessName || 'Your Farrier Service';
    let html, subject;

    if (action === 'confirmation') {
      html = buildConfirmationHtml(body);
      subject = `✅ Appointment Confirmed — ${bizName} on ${requestedDate}`;
    } else if (action === 'cancellation') {
      html = buildCancellationHtml(body);
      subject = `Appointment Cancellation — ${bizName} on ${requestedDate}`;
    } else if (action === 'update') {
      html = buildUpdateHtml(body);
      subject = `📝 Appointment Update — ${bizName} on ${requestedDate}`;
    } else {
      return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
    }

    await sendEmail({ to: customerEmail, subject, html, replyTo: farrierEmail || undefined });
    console.log(`✅ ${action} email sent to`, customerEmail);
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('send-email error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
