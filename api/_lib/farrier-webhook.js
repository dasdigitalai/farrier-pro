// Per-farrier Stripe webhook: /api/stripe/webhook/{farrierId}
// (vercel.json rewrites it to /api/stripe-payment?webhookFarrier={farrierId} — it runs
// inside stripe-payment because the Hobby plan allows only 12 functions per deploy)
//
// Each farrier's own Stripe account sends checkout.session.completed here. The endpoint
// is created automatically when the farrier saves their keys (Settings → Stripe Payments);
// its signing secret lives in farrierSecrets/{farrierId}.stripeWebhookSecret.
import Stripe from 'stripe';
import { getDoc, getStripeSecretKey, serverAuth } from './firebase-rest.js';
import { recordCheckoutSession, APP_URL } from './invoice-payments.js';

async function sendPaidSms(to, name, amountCents, invoiceNumber) {
  if (!to) return;
  try {
    const { idToken } = await serverAuth();
    await fetch(`${APP_URL}/api/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ to, body: `Hi ${name || 'there'}, your payment of $${(amountCents / 100).toFixed(2)} for invoice #${invoiceNumber} has been received. Thank you! Reply STOP to opt out.` }),
    });
  } catch (e) { console.warn('Confirmation SMS error:', e.message); }
}

// Records a completed Checkout Session from a webhook (this one, or FarriTech's own account
// webhook in stripe-payment.js) and texts the customer the first time it's recorded. The
// customer's return to /pay records the same session; whichever comes second does nothing.
export async function recordWebhookSession(stripe, farrierId, session) {
  const result = await recordCheckoutSession(stripe, farrierId, session);
  console.log(`📥 checkout.session.completed ${session.id} for ${farrierId}:`, JSON.stringify({ invoiceId: result.invoiceId, status: result.status, ignored: result.ignored, duplicate: result.duplicate, alreadyPaid: result.alreadyPaid }));
  if (result.status && !result.duplicate && !result.alreadyPaid) {
    await sendPaidSms(session.customer_details?.phone, session.customer_details?.name, session.amount_total || 0, result.invoice?.invoiceNumber || '');
  }
  return result;
}

// rawBody: the exact bytes Stripe sent (signature checks need them).
export async function farrierWebhook(req, res, rawBody, farrierId) {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(farrierId)) return res.status(400).json({ error: 'Bad farrier id' });

  const secrets = await getDoc(`farrierSecrets/${farrierId}`).catch(() => null);
  if (!secrets?.stripeWebhookSecret) return res.status(400).json({ error: 'Webhook not configured' });

  let event;
  try {
    event = Stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], secrets.stripeWebhookSecret);
  } catch (err) {
    console.error(`Rejected webhook for ${farrierId} with bad signature:`, err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (event.type !== 'checkout.session.completed') return res.status(200).json({ received: true });

  try {
    const key = await getStripeSecretKey(farrierId);
    if (!key) return res.status(400).json({ error: 'Farrier has no Stripe key' });
    await recordWebhookSession(new Stripe(key), farrierId, event.data.object);
    return res.status(200).json({ received: true });
  } catch (err) {
    // 500 makes Stripe retry later; recording is idempotent per session.
    console.error(`❌ Webhook error for ${farrierId}:`, err);
    return res.status(500).json({ error: err.message });
  }
}
