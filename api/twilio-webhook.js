// Vercel serverless function - handles incoming SMS replies from customers
// Processes CONFIRM (marks the next appointment customer-confirmed) and STOP/START (opt out/in).
// Any other text from a farrier with an open support ticket is logged onto that ticket (support.html).
// api/twilio-webhook.js
//
// Runs as the server user (see _lib/firebase-rest.js), not as an anonymous caller.

import { randomUUID } from 'crypto';
import { queryIn, patchDoc } from './_lib/firebase-rest.js';

// Phones are stored however they were typed ("561-444-7777", "(561) 444-7777", "+15614447777"…),
// so look a number up under every common spelling of its last 10 digits.
function phoneSpellings(from) {
  const d = String(from || '').replace(/\D/g, '').slice(-10);
  if (d.length !== 10) return [];
  const [a, b, c] = [d.slice(0, 3), d.slice(3, 6), d.slice(6)];
  return [
    d, `1${d}`, `+1${d}`,
    `(${a}) ${b}-${c}`, `(${a})${b}-${c}`, `${a}-${b}-${c}`, `${a}.${b}.${c}`, `${a} ${b} ${c}`,
    `+1 (${a}) ${b}-${c}`, `1-${a}-${b}-${c}`, `+1-${a}-${b}-${c}`, `+1 ${a}-${b}-${c}`,
  ];
}

// Today's date as YYYY-MM-DD in the farriers' timezone (requestedDate uses the same format).
function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function fmtWhen(date, time) {
  const d = new Date(`${date}T12:00:00`);
  const day = isNaN(d) ? date : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  if (!time) return day;
  const [h, m] = time.split(':').map(Number);
  return `${day} at ${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// A farrier replying to a support text: add the reply to their most recently active open
// ticket and flag it unread. Returns true if it was logged.
async function logSupportReply(from, body) {
  const d = String(from || '').replace(/\D/g, '').slice(-10);
  if (d.length !== 10 || !body) return false;
  const ticket = (await queryIn('supportTickets', 'phoneDigits', [d]))
    .filter(t => t.status !== 'closed')
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
  if (!ticket) return false;
  const now = new Date();
  await patchDoc(`supportTickets/${ticket.id}/messages/${randomUUID().replace(/-/g, '')}`, {
    kind: 'sms', direction: 'in', body, from, createdAt: now,
  });
  await patchDoc(`supportTickets/${ticket.id}`, {
    status: 'open', unread: true, updatedAt: now, lastMessageAt: now, lastMessagePreview: body.slice(0, 140),
  });
  return true;
}

async function setOptOut(phones, optOut) {
  const customers = await queryIn('customers', 'phone', phones);
  for (const c of customers) await patchDoc(`customers/${c.id}`, { smsOptOut: optOut });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const twiml = (msg) =>
    `<?xml version="1.0" encoding="UTF-8"?><Response>${msg ? `<Message>${msg}</Message>` : ''}</Response>`;

  res.setHeader('Content-Type', 'text/xml');

  try {
    const { From, Body } = req.body;
    const reply = (Body || '').trim().toUpperCase();
    const phones = phoneSpellings(From);
    if (!phones.length) return res.status(200).send(twiml(''));

    if (reply === 'STOP') {
      await setOptOut(phones, true);
      return res.status(200).send(twiml('You have been unsubscribed. Reply START to resubscribe.'));
    }

    if (reply === 'START') {
      await setOptOut(phones, false);
      return res.status(200).send(twiml('You have been resubscribed and will receive appointment and invoice notifications.'));
    }

    if (reply === 'CONFIRM') {
      // Confirm the soonest upcoming appointment booked under this phone number.
      const today = todayET();
      const upcoming = (await queryIn('appointments', 'phone', phones))
        .filter(a => ['confirmed', 'scheduled', 'pending'].includes(a.status) && a.requestedDate && a.requestedDate >= today)
        .sort((x, y) => `${x.requestedDate} ${x.requestedTime || ''}`.localeCompare(`${y.requestedDate} ${y.requestedTime || ''}`));
      const next = upcoming.find(a => !a.customerConfirmed) || upcoming[0];
      if (!next) {
        return res.status(200).send(twiml('We could not find an upcoming appointment to confirm. Please contact your farrier directly.'));
      }
      // A flag, not a status change: the farrier's own confirmed/pending status stays as is.
      await patchDoc(`appointments/${next.id}`, { customerConfirmed: true, customerConfirmedAt: new Date() });
      return res.status(200).send(twiml(`Thank you! Your appointment on ${fmtWhen(next.requestedDate, next.requestedTime)} is confirmed.`));
    }

    if (reply === 'HELP') {
      return res.status(200).send(twiml('FarriTech: For help contact support@farritech.app. Reply STOP to unsubscribe. Msg & Data rates may apply.'));
    }

    await logSupportReply(From, (Body || '').trim());
    return res.status(200).send(twiml(''));

  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(200).send(twiml(''));
  }
}
