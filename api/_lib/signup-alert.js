// Texts the FarriTech owner when a new farrier account is created.
//
// Served as /api/notify-signup — vercel.json rewrites that to api/send-sms (Vercel's
// Hobby plan caps a deployment at 12 functions). The browser calls it right after it writes the new farriers/{uid} profile, with the
// new user's ID token. The server checks the profile really exists and was just created,
// marks it signupNotifiedAt (so a retry or a second tab never texts twice), then sends
// the SMS through Twilio.
//
// Env vars: SIGNUP_ALERT_PHONE (one or more numbers, comma-separated), plus the
// TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_MESSAGING_SERVICE_SID used by send-sms.
import { callerFromRequest, runTransaction } from './firebase-rest.js';

// Only profiles created this recently count as a new signup — stops an old account
// from texting the owner just by calling this endpoint.
const NEW_ACCOUNT_WINDOW_MS = 60 * 60 * 1000;

function toE164(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length === 11 && digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
}

function formatPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(raw || '');
}

async function sendSms(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      MessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      To: to,
      Body: body,
    }).toString(),
  });
  const data = await r.json();
  if (!r.ok || data.error_code) throw new Error(`Twilio ${data.code || data.error_code}: ${data.message}`);
  return data.sid;
}

export async function notifySignup(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const caller = await callerFromRequest(req).catch(() => null);
  if (!caller) return res.status(401).json({ error: 'Not authorized' });

  const recipients = String(process.env.SIGNUP_ALERT_PHONE || '').split(',').map(toE164).filter(Boolean);
  if (!recipients.length) return res.status(200).json({ ok: false, skipped: 'SIGNUP_ALERT_PHONE not set' });
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_MESSAGING_SERVICE_SID) {
    return res.status(500).json({ error: 'Twilio credentials not configured' });
  }

  try {
    const path = `farriers/${caller.uid}`;
    // Claim the notification first; if two calls race, only one commit wins.
    const profile = await runTransaction(async (tx) => {
      const p = await tx.get(path);
      if (!p || p.signupNotifiedAt) return null;
      const created = Date.parse(p.createdAt || '');
      if (!created || Date.now() - created > NEW_ACCOUNT_WINDOW_MS) return null;
      tx.patch(path, { signupNotifiedAt: new Date() });
      return p;
    });
    if (!profile) return res.status(200).json({ ok: true, skipped: 'not a new signup' });

    const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    const place = [profile.city, profile.state].filter(Boolean).join(', ');
    const body = [
      '🐴 New FarriTech signup!',
      profile.businessName || 'My Farrier Business',
      name,
      profile.email || caller.email,
      profile.phone ? formatPhone(profile.phone) : '',
      place,
    ].filter(Boolean).join('\n');

    const results = await Promise.allSettled(recipients.map(to => sendSms(to, body)));
    const failed = results.filter(r => r.status === 'rejected');
    failed.forEach(f => console.error('notify-signup SMS failed:', f.reason?.message));
    return res.status(200).json({ ok: failed.length < results.length, sent: results.length - failed.length });
  } catch (err) {
    console.error('notify-signup error:', err);
    return res.status(500).json({ error: 'Failed to send signup alert' });
  }
}
