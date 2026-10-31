// Invoice payments shared by api/stripe-payment.js, the /pay page (_lib/pay-page.js) and the
// per-farrier Stripe webhook (_lib/farrier-webhook.js).
//
// Every payment — Checkout (pay link), keyed card, cash/check/etc. — goes through
// applyPayment(), which runs in a Firestore transaction so two payments can't both
// mark the same invoice paid, and the same Stripe payment can't be counted twice.
//
// Where things live:
//   invoices/{id}                  status, payments[] (what the screens read), paidAmount,
//                                  amountPaidCents, balanceDue, checkoutSessionId, paymentUrl …
//   invoices/{id}/payments/{pid}   one doc per payment (pid = Checkout Session id,
//                                  PaymentIntent id, or a random id for manual payments)
//   farrierSecrets/{uid}           stripeWebhookId, stripeWebhookSecret (never sent to browsers)
import crypto from 'crypto';
import '../../lib/pricing.js';
import { getDoc, patchDoc, queryIn, runTransaction, serverAuth } from './firebase-rest.js';

const P = globalThis.FarriPricing;

export const APP_URL = (process.env.APP_URL || 'https://app.farritech.com').replace(/\/$/, '');
// Customers always get this link. It never expires — it opens (or creates) a Checkout
// Session at the current price, so a link texted last week still works.
// On a Vercel preview they point at that preview's branch URL instead, so a preview can be
// tested end to end (production doesn't have what's being tested yet).
const PAY_BASE = process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_BRANCH_URL ? `https://${process.env.VERCEL_BRANCH_URL}` : APP_URL;
export const payUrlFor = (invoiceId) => `${PAY_BASE}/pay/${invoiceId}`;

export class PaymentError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const WEBHOOK_PERMISSION_MESSAGE = 'Your Stripe key needs Webhook Endpoints permission. Edit the key in Stripe → Developers → API keys and set Webhook Endpoints to Write, then save again.';

export async function cardDetails(stripe, paymentIntentId) {
  try {
    const charges = await stripe.charges.list({ payment_intent: paymentIntentId, limit: 1 });
    const card = charges.data[0]?.payment_method_details?.card;
    const brand = card?.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : 'Card';
    return { last4: card?.last4 || '', brand };
  } catch (e) { return { last4: '', brand: 'Card' }; }
}

// Records one payment against an invoice.
//   paymentId    idempotency key (Stripe object id, or omit for a manual payment)
//   method       card_link | card_keyed | tap_to_pay | card_terminal | cash | check | ach | zelle | venmo | other
//   amountCents  what was actually collected
//   creditCents  how much of the cash-price balance it pays down (default: worked out from
//                the invoice's cardPriceRate)
//   source       'stripe' or 'ipospays' when the processor already took the money — then an
//                already-paid invoice gets the payment logged for review instead of an error
//   processorDetails  optional object saved on the payment doc (ids a refund or void would need)
export async function applyPayment(invoiceId, {
  paymentId = crypto.randomUUID(), method, amountCents, creditCents,
  reference = '', source = 'manual', recordedBy = '', paidDate = null,
  sessionId = '', paymentIntentId = '', last4 = '', brand = '', paidVia = '', processorDetails = null,
}) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new PaymentError('Invalid amount.');
  const isCard = P.isCardMethod(method);
  return runTransaction(async (tx) => {
    const inv = await tx.get(`invoices/${invoiceId}`);
    if (!inv) throw new PaymentError('Invoice not found.', 404);
    if (await tx.get(`invoices/${invoiceId}/payments/${paymentId}`)) return { duplicate: true, status: inv.status };

    const paymentDoc = {
      method, amountCents, reference, source, recordedBy,
      ...(sessionId ? { stripeSessionId: sessionId } : {}),
      ...(paymentIntentId ? { stripePaymentIntent: paymentIntentId } : {}),
      ...(last4 ? { cardLast4: last4, cardBrand: brand } : {}),
      // What a later refund or void needs (e.g. iPOSpays RRN and card token). Payment docs are
      // readable only by the farrier and the server, never by the customer.
      ...(processorDetails ? { processorDetails } : {}),
      createdAt: new Date(),
    };

    if (inv.status === 'paid' || inv.status === 'cancelled') {
      if (source !== 'stripe' && source !== 'ipospays') throw new PaymentError(inv.status === 'paid' ? 'This invoice is already paid.' : 'This invoice is cancelled.', 409);
      // The processor already has the money (e.g. the customer paid online at the same moment the
      // farrier recorded cash). Keep a record so the farrier can refund it.
      tx.create(`invoices/${invoiceId}/payments/${paymentId}`, { ...paymentDoc, creditCents: 0, unapplied: true });
      tx.patch(`invoices/${invoiceId}`, { paymentNeedsReview: true });
      console.warn(`Payment ${paymentId} arrived for ${inv.status} invoice ${invoiceId} — logged as unapplied`);
      return { alreadyPaid: true, status: inv.status };
    }

    const credit = Number.isInteger(creditCents) ? creditCents : P.creditForPayment(inv, method, amountCents);
    const creditedAfter = P.creditedCents(inv) + credit;
    const totalCents = P.toCents(inv.total);
    const status = creditedAfter >= totalCents ? 'paid' : 'partial';
    const when = paidDate || new Date();

    const payments = [...(Array.isArray(inv.payments) ? inv.payments : []), {
      amount: amountCents / 100,
      creditAmount: credit / 100,
      method: isCard ? 'credit_card' : method,
      memo: last4 ? `${brand || 'Card'} ending ${last4}` : (reference || P.MANUAL_METHODS[method] || ''),
      date: when.toISOString(),
      paymentId,
      ...(paymentIntentId ? { transactionId: paymentIntentId } : {}),
    }];
    const paidCents = payments.reduce((s, p) => s + P.toCents(p.amount), 0);

    tx.create(`invoices/${invoiceId}/payments/${paymentId}`, { ...paymentDoc, creditCents: credit, paidAt: when });
    tx.patch(`invoices/${invoiceId}`, {
      status,
      payments,
      paidAmount: paidCents / 100,
      amountPaidCents: paidCents,
      balanceDue: Math.max(0, totalCents - creditedAfter) / 100,
      priceApplied: isCard && P.invoiceRate(inv) > 0 && !inv.cardFeeWaived ? 'card' : 'cash',
      updatedAt: new Date(),
      ...(status === 'paid' ? { paidAt: when, paymentMethod: isCard ? 'card' : method } : {}),
      ...(paymentIntentId ? { transactionId: paymentIntentId, stripePaymentIntentId: paymentIntentId } : {}),
      ...(sessionId ? { stripeSessionId: sessionId } : {}),
      ...(last4 ? { cardLast4: last4, cardType: brand } : {}),
      ...(paidVia ? { paidVia } : {}),
      ...(method === 'check' && reference ? { checkNumber: reference } : {}),
    });
    return { status, creditCents: credit, balanceCents: Math.max(0, totalCents - creditedAfter) };
  });
}

// Closes the invoice's open Checkout Session (and any legacy Payment Link) so the customer
// can't pay online for something that's already settled. Returns the session it found.
export async function closeOnlinePayment(stripe, invoice) {
  let session = null;
  if (invoice.checkoutSessionId) {
    try {
      session = await stripe.checkout.sessions.retrieve(invoice.checkoutSessionId);
      if (session.status === 'open') await stripe.checkout.sessions.expire(session.id);
    } catch (e) { /* already completed or expired */ }
  }
  if (invoice.paymentLinkId) await stripe.paymentLinks.update(invoice.paymentLinkId, { active: false }).catch(() => {});
  return session;
}

// Before Stripe is disconnected: closes every Checkout Session the farrier's customers could
// still pay, and records any that a customer has just paid. Once the key is gone a payment on
// one could never be recorded or refunded here. Throws PaymentError naming the invoices it
// couldn't check, so the caller can keep Stripe connected. A key Stripe no longer accepts
// can't close anything, so that doesn't block.
export async function closeStripeCheckouts(stripe, farrierId) {
  const open = (await queryIn('invoices', 'farrierId', [farrierId]))
    .filter(inv => inv.checkoutSessionId && inv.status !== 'paid' && inv.status !== 'cancelled');
  const failed = [];
  let closed = 0, paid = 0;
  const closeOne = async (inv) => {
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(inv.checkoutSessionId);
      if (session.status === 'open') {
        try { await stripe.checkout.sessions.expire(session.id); closed++; return; }
        // Can't expire a session that was paid a moment ago — look once more.
        catch (e) { session = await stripe.checkout.sessions.retrieve(session.id); }
      }
      if (session.status === 'complete' && session.payment_status === 'paid') {
        await recordCheckoutSession(stripe, farrierId, session);
        paid++;
      }
    } catch (e) {
      if (e.type === 'StripeAuthenticationError' || e.code === 'resource_missing') return;
      console.error('Stripe disconnect: could not close checkout', inv.id, e.message);
      failed.push(inv.invoiceNumber || inv.id);
    }
  };
  for (let i = 0; i < open.length; i += 5) await Promise.all(open.slice(i, i + 5).map(closeOne));
  if (failed.length) {
    throw new PaymentError(`Stripe is still connected: couldn’t close the payment page for invoice${failed.length > 1 ? 's' : ''} #${failed.join(', #')}. Try again in a minute.`, 502);
  }
  return { closed, paid };
}

// Creates a Checkout Session for what's still owed on the invoice (card price unless
// waived) and saves it on the invoice. Expires the previous session first.
export async function createCheckoutSession(stripe, invoiceId, invoice) {
  const cashCents = P.balanceCents(invoice);
  if (cashCents <= 0) throw new PaymentError('Nothing is owed on this invoice.');
  const chargeCents = P.getChargeCents(invoice, 'card_link', cashCents);
  const priceType = chargeCents !== cashCents ? 'card' : 'cash';
  const previous = await closeOnlinePayment(stripe, invoice);
  if (previous?.status === 'complete' && previous.payment_status === 'paid') {
    // Paid a moment ago and the webhook hasn't landed yet — record it, don't offer a second checkout.
    await recordCheckoutSession(stripe, invoice.farrierId, previous);
    throw new PaymentError('Customer already paid by card.', 409);
  }

  const number = invoice.invoiceNumber || invoiceId;
  const metadata = {
    invoiceId, farrierId: invoice.farrierId, invoiceNumber: String(invoice.invoiceNumber || ''),
    baseCents: String(cashCents), cardCents: String(chargeCents), priceType,
  };
  const email = String(invoice.customerEmail || '').trim();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: chargeCents,
        product_data: {
          name: `Invoice #${number}`,
          ...(priceType === 'card' ? { description: `Card price. Cash or check price: ${P.money(cashCents)}` } : {}),
        },
      },
    }],
    metadata,
    payment_intent_data: { description: `FarriTech Invoice #${number}`, metadata },
    ...(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? { customer_email: email } : {}),
    success_url: `${payUrlFor(invoiceId)}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${payUrlFor(invoiceId)}?canceled=1`,
  });

  const paymentUrl = payUrlFor(invoiceId);
  await patchDoc(`invoices/${invoiceId}`, {
    checkoutSessionId: session.id,
    checkoutSessionCents: chargeCents,
    priceType,
    paymentUrl,
    paymentLinkUrl: paymentUrl,
    updatedAt: new Date(),
  });
  return { session, paymentUrl, chargeCents, cashCents };
}

// Records a completed Checkout Session (webhook, or the customer landing back on /pay).
// Handles new sessions (metadata.invoiceId) and legacy Payment Link checkouts.
export async function recordCheckoutSession(stripe, farrierId, session) {
  if (session.payment_status !== 'paid') return { ignored: 'not paid' };
  let invoiceId = session.metadata?.invoiceId || '';
  const legacyLinkId = !invoiceId && session.payment_link ? session.payment_link : '';
  if (legacyLinkId) {
    const link = await stripe.paymentLinks.retrieve(legacyLinkId).catch(() => null);
    invoiceId = link?.metadata?.invoiceId || '';
    if (!invoiceId) {
      const matches = [
        ...await queryIn('invoices', 'stripePaymentLinkId', [legacyLinkId]),
        ...await queryIn('invoices', 'paymentLinkId', [legacyLinkId]),
      ];
      invoiceId = matches.find(m => m.farrierId === farrierId)?.id || '';
    }
  }
  if (!invoiceId) return { ignored: 'no matching invoice' };
  const invoice = await getDoc(`invoices/${invoiceId}`);
  if (!invoice || invoice.farrierId !== farrierId) return { ignored: 'invoice belongs to another farrier' };

  const amountCents = session.amount_total || 0;
  const baseCents = Number(session.metadata?.baseCents);
  const card = session.payment_intent ? await cardDetails(stripe, session.payment_intent) : {};
  const result = await applyPayment(invoiceId, {
    paymentId: session.id,
    method: 'card_link',
    amountCents,
    // New sessions say exactly how much cash-price balance they cover; legacy links had no card price.
    creditCents: Number.isInteger(baseCents) && baseCents > 0 ? baseCents : amountCents,
    source: 'stripe',
    sessionId: session.id,
    paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : '',
    last4: card.last4 || '', brand: card.brand || '',
    paidVia: legacyLinkId ? 'stripe_payment_link' : 'stripe_link',
  });
  if (legacyLinkId) await stripe.paymentLinks.update(legacyLinkId, { active: false }).catch(() => {});
  return { invoiceId, invoice, ...result };
}

// Replaces FarriTech's webhook endpoint in the farrier's own Stripe account and stores its
// signing secret server-side. Throws PaymentError(WEBHOOK_PERMISSION_MESSAGE) if the key
// isn't allowed to manage webhooks.
export async function setupWebhook(stripe, farrierId) {
  try {
    const existing = await stripe.webhookEndpoints.list({ limit: 100 });
    for (const ep of existing.data) {
      if (String(ep.url).includes('/api/stripe/webhook/')) await stripe.webhookEndpoints.del(ep.id);
    }
    const endpoint = await stripe.webhookEndpoints.create({
      url: `${APP_URL}/api/stripe/webhook/${farrierId}`,
      enabled_events: ['checkout.session.completed'],
      description: 'FarriTech invoice payments',
    });
    await patchDoc(`farrierSecrets/${farrierId}`, {
      stripeWebhookId: endpoint.id, stripeWebhookSecret: endpoint.secret, stripeWebhookCreatedAt: new Date(),
    });
    return endpoint.id;
  } catch (e) {
    if (e.type === 'StripePermissionError' || e.statusCode === 403) throw new PaymentError(WEBHOOK_PERMISSION_MESSAGE, 403);
    throw e;
  }
}

export async function removeWebhook(stripe, farrierId) {
  const secrets = await getDoc(`farrierSecrets/${farrierId}`);
  if (stripe && secrets?.stripeWebhookId) await stripe.webhookEndpoints.del(secrets.stripeWebhookId).catch(() => {});
  await patchDoc(`farrierSecrets/${farrierId}`, {}, ['stripeWebhookId', 'stripeWebhookSecret', 'stripeWebhookCreatedAt']);
}

// Texts and/or emails the customer the (unchanged) pay link with the new amount.
// Deliberately says nothing about a removed or added card price.
export async function sendUpdatedPayLink(invoice, invoiceId, amountCents) {
  const farrier = await getDoc(`farriers/${invoice.farrierId}`).catch(() => null);
  const biz = farrier?.businessName || 'Your Farrier';
  const name = String(invoice.customerName || '').split(' ')[0] || 'there';
  const number = invoice.invoiceNumber || invoiceId;
  const url = payUrlFor(invoiceId);
  const amount = P.money(amountCents);
  const altPaySms = P.altPaySms(farrier, invoice);
  const { idToken } = await serverAuth();
  const sent = [];

  if (invoice.customerPhone) {
    const r = await fetch(`${APP_URL}/api/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ to: invoice.customerPhone, body: `Hi ${name}, here is your updated payment link for Invoice #${number} from ${biz}: ${amount}.${P.itemsSmsText(invoice)} Pay here: ${url}${altPaySms} Reply STOP to opt out.` }),
    }).catch(() => null);
    if (r?.ok) sent.push('text');
  }
  if (invoice.customerEmail) {
    const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#333;max-width:560px;margin:0 auto;padding:20px;">
  <p>Hi ${escapeHtml(name)},</p>
  <p>Here is your updated payment link for Invoice #${escapeHtml(number)} from <strong>${escapeHtml(biz)}</strong>: <strong>${amount}</strong>.</p>
  <p style="text-align:center;margin:28px 0;"><a href="${url}" style="background:#059669;color:#fff;padding:14px 32px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;">Pay ${amount}</a></p>
  ${P.altPayHtml(farrier, invoice)}
  <p style="color:#9ca3af;font-size:12px;">Powered by FarriTech</p>
</body></html>`;
    const r = await fetch(`${APP_URL}/api/send-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ to: invoice.customerEmail, subject: `Updated payment link for Invoice #${number}`, html }),
    }).catch(() => null);
    if (r?.ok) sent.push('email');
  }
  return sent;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
