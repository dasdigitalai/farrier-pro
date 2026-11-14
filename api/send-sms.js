// Vercel serverless function for sending SMS via Twilio
// api/send-sms.js
//
// Only signed-in farriers, FarriTech support staff (support.html), or the server itself
// (e.g. payment confirmations) may send —
// otherwise anyone could text any number on FarriTech's Twilio account.
import { authorizeSender } from './_lib/firebase-rest.js';
import { notifySignup } from './_lib/signup-alert.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // /api/notify-signup (rewritten here in vercel.json) — new-signup text to the owner.
  if (req.query?.signupAlert) return notifySignup(req, res);

  // Farriers texting their customers, or FarriTech support texting a farrier (support.html).
  const auth = await authorizeSender(req, 'send-sms');
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  if (!accountSid || !authToken || !messagingServiceSid) {
    return res.status(500).json({ error: 'Twilio credentials not configured' });
  }

  try {
    const { to, body, farrierId } = req.body;

    if (!to || !body) {
      return res.status(400).json({ error: 'Missing required fields: to, body' });
    }

    // Format phone number to E.164
    const phone = to.replace(/\D/g, '');
    const e164 = phone.startsWith('1') ? `+${phone}` : `+1${phone}`;

    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          MessagingServiceSid: messagingServiceSid,
          To: e164,
          Body: body,
        }).toString(),
      }
    );

    const data = await response.json();

    if (data.error_code) {
      console.error('Twilio error:', data);
      return res.status(400).json({ error: data.message, code: data.error_code });
    }

    return res.status(200).json({
      success: true,
      messageSid: data.sid,
      status: data.status,
    });

  } catch (err) {
    console.error('SMS send error:', err);
    return res.status(500).json({ error: 'Failed to send SMS' });
  }
}
