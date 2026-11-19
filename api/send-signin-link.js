// api/send-signin-link.js
// Generates a Firebase email sign-in link via REST API and sends it via Resend.
// Requires env vars: FIREBASE_WEB_API_KEY, RESEND_API_KEY
import { withNoReplyNotice } from './_lib/no-reply-notice.js';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;
const FROM = 'FarriTech <noreply@farritech.com>';
const PORTAL_URL = 'https://app.farritech.com/customer-portal.html';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });

  if (!RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
  if (!FIREBASE_WEB_API_KEY) return res.status(500).json({ error: 'FIREBASE_WEB_API_KEY not configured' });

  try {
    // Generate magic link via Firebase REST API (no Admin SDK / service account needed)
    const firebaseRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_WEB_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestType: 'EMAIL_SIGNIN',
          email,
          continueUrl: PORTAL_URL,
          canHandleCodeInApp: true,
        }),
      }
    );

    const firebaseData = await firebaseRes.json();

    if (!firebaseRes.ok) {
      const msg = firebaseData?.error?.message || 'Firebase error';
      throw new Error(msg);
    }

    // Firebase sends its own email by default — we need to intercept.
    // Since we can't fully suppress Firebase's email via REST,
    // we use the oobCode from the response to build the link ourselves
    // and send our branded email via Resend.
    const oobCode = firebaseData.oobCode;
    if (!oobCode) throw new Error('No oobCode returned from Firebase');

    // Build the magic link using the oobCode
    const magicLink = `https://app.farritech.com/customer-portal.html?mode=signIn&oobCode=${oobCode}&apiKey=${FIREBASE_WEB_API_KEY}&lang=en`;

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.6;color:#333;max-width:560px;margin:0 auto;padding:20px;">
  <div style="text-align:center;padding:24px 30px;background:linear-gradient(135deg,#0D1320 0%,#1a2a4a 100%);border-radius:10px 10px 0 0;">
    <img src="https://app.farritech.com/public/farritech_logo_letters_white.png" alt="FarriTech" style="height:50px;width:auto;" />
  </div>
  <div style="background:#fff;padding:32px 30px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;">
    <h2 style="margin:0 0 0.5rem;color:#0D1320;font-size:1.4rem;">Your Sign-In Link</h2>
    <p style="color:#6b7280;margin:0 0 1.5rem;font-size:0.95rem;">
      Click the button below to securely sign in to your FarriTech customer portal and view your invoices.
      This link expires in 1 hour and can only be used once.
    </p>
    <div style="text-align:center;margin:1.5rem 0;">
      <a href="${magicLink}" style="background:linear-gradient(135deg,#2683FB 0%,#46C5FF 100%);color:#fff;padding:14px 36px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;font-size:1rem;">
        Sign In to FarriTech
      </a>
    </div>
    <p style="color:#9ca3af;font-size:0.8rem;text-align:center;margin:1.5rem 0 0;">
      If you didn't request this link, you can safely ignore this email.<br/>
      This link can only be used once and expires in 1 hour.
    </p>
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:0.75rem;margin-top:1rem;">
    &copy; ${new Date().getFullYear()} FarriTech &mdash; Advanced Farrier Solutions<br/>
    <a href="https://farritech.com" style="color:#9ca3af;">farritech.com</a>
  </p>
</body>
</html>`;

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: [email],
        subject: 'Your FarriTech Sign-In Link',
        html: withNoReplyNotice(html),
      }),
    });

    const emailData = await emailRes.json();
    if (!emailRes.ok) throw new Error(emailData.message || 'Resend error');

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('send-signin-link error:', err);
    return res.status(500).json({ error: err.message || 'Failed to send sign-in link' });
  }
}
