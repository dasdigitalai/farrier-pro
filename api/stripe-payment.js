import Stripe from 'stripe';
import crypto from 'crypto';
import '../lib/pricing.js';
import { callerFromRequest, getDoc, patchDoc, listDocs, getStripeSecretKey, setStripeSecretKey, getGoogleRefreshToken } from './_lib/firebase-rest.js';
import {
  applyPayment, cardDetails, closeOnlinePayment, closeStripeCheckouts, createCheckoutSession, recordCheckoutSession,
  removeWebhook, sendUpdatedPayLink, setupWebhook, PaymentError,
} from './_lib/invoice-payments.js';
import { payPage } from './_lib/pay-page.js';
import { farrierWebhook, recordWebhookSession } from './_lib/farrier-webhook.js';
import { businessFor, requireRole, teamAccept, teamInvite, teamRemove, teamSetRole, teamStatus } from './_lib/team.js';
import { closeIposPages, connectIpospays, createIposPage, disconnectIpospays, getIposCreds, iposCallback, refundIposPayment, syncIposPayment } from './_lib/ipospays.js';

const P = globalThis.FarriPricing;
const SECRET_KEY_RE = /^(sk|rk)_(live|test)_/;
// A farrier takes card payments through one processor at a time, so a payment can't be
// split across two or left on one they've stopped watching.
const ONE_PROCESSOR = (connected, wanted) =>
  `FarriTech takes card payments through one processor at a time. Disconnect ${connected} in Settings first, then connect ${wanted}.`;

// May run one-off maintenance actions (same list as the sponsorBanners rule).
const ADMIN_EMAILS = ['david@dasconsulting.com', 'david@dasdigitalai.com'];

// Disable body parser so we can read raw body for webhook signature verification
export const config = { api: { bodyParser: false } };

// Stripe secret keys never travel through browsers. Callers prove who they are with a
// Firebase ID token (Authorization: Bearer <token>) and the server looks up the right
// farrier's key in the locked farrierSecrets collection (see _lib/firebase-rest.js).
//
// Who can call what:
//   farrier (signed in)   → status, connect, disconnect, charge, refund, payment_link, deactivate_link,
//                           record_payment, waive_card_price, manager_password_status, set_manager_password
//   customer (portal)     → customer_charge  (amount computed here from their own unpaid invoices)
//   admin                 → migrate_all      (one-time: move legacy Stripe keys + Google tokens off public profiles)
//                           reset_manager_password (clears a farrier's forgotten manager password)
//   anyone                → confirm_session  (only marks paid after Stripe confirms the session)
//   Stripe                → webhook          (legacy platform webhook, signature required; farriers'
//                                               own accounts post to /api/stripe/webhook/{farrierId} → _lib/farrier-webhook.js)
//   farrier (signed in)   → ipospays_connect, ipospays_disconnect, ipospays_status, ipospays_refund,
//                           ipospays_keyed (card form to key a card into), ipospays_check (did it go through?)
//   farrier (signed in)   → team_status, team_invite, team_remove, team_set_role, team_accept (_lib/team.js)
//   iPOSpays              → /api/ipospays/callback/{invoiceId} → _lib/ipospays.js (re-checked with iPOSpays before recording)
//
// A farrier connects Stripe or iPOSpays, not both (connect / ipospays_connect refuse while the
// other is connected; each disconnect closes that processor's open payment pages first).
// With iPOSpays, payment_link / waive_card_price, keyed cards (ipospays_keyed) and the /pay
// page use iPOSpays payment pages (refunded with ipospays_refund). The customer portal's card
// payments need Stripe.
//
// Amounts are always worked out here from the invoice (lib/pricing.js), never taken from
// the browser — see api/_lib/invoice-payments.js for how payments are recorded.

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function ownInvoice(invoiceId, farrierId) {
  if (!invoiceId) throw new PaymentError('Missing invoiceId.');
  const invoice = await getDoc(`invoices/${invoiceId}`);
  if (!invoice || invoice.farrierId !== farrierId) throw new PaymentError('Invoice not found.', 404);
  return invoice;
}

// Manager password is stored as "scrypt$<salt>$<hash>" in farrierSecrets/{uid}.
function hashManagerPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(String(password), salt, 32).toString('hex')}`;
}
function checkManagerPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const actual = crypto.scryptSync(String(password || ''), Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(actual, Buffer.from(hashHex, 'hex'));
}

async function handleWebhook(req, res, rawBody) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return res.status(400).json({ error: 'Webhook not configured' });
  let event;
  try {
    event = Stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], webhookSecret);
  } catch (err) {
    console.error('Rejected webhook with bad signature:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }
  console.log('📥 Stripe webhook:', event.type);

  // Only checkout sessions from FarriTech's own Stripe account arrive here (a farrier whose
  // keys are for that account, e.g. in testing); farriers' own accounts use the per-farrier
  // webhook. Record them the same way, so a payment the per-farrier webhook or the return
  // to /pay already recorded isn't logged a second time. Keyed and customer-portal charges
  // are recorded when they're taken, so payment_intent.succeeded needs nothing here.
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const invoiceId = session.metadata?.invoiceId || '';
      const invoice = invoiceId ? await getDoc(`invoices/${invoiceId}`) : null;
      const key = invoice?.farrierId ? await getStripeSecretKey(invoice.farrierId) : null;
      if (key) await recordWebhookSession(new Stripe(key), invoice.farrierId, session);
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('❌ Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,stripe-signature');
  if (req.method === 'OPTIONS') return res.status(200).end();
  // Customer pay link (/pay/:invoiceId, see vercel.json)
  if (req.method === 'GET' && req.query?.payPage) return payPage(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = await getRawBody(req);
  // Farrier's own Stripe account (/api/stripe/webhook/:farrierId, see vercel.json)
  if (req.query?.webhookFarrier) return farrierWebhook(req, res, rawBody, String(req.query.webhookFarrier));
  // iPOSpays payment callback (/api/ipospays/callback/:invoiceId, see vercel.json)
  if (req.query?.iposCallback) return iposCallback(req, res, rawBody, String(req.query.iposCallback));
  if (req.headers['stripe-signature']) return handleWebhook(req, res, rawBody);

  try {
    const body = JSON.parse(rawBody.toString() || '{}');
    const { action } = body;

    // ── Public: confirm a payment-link checkout after the customer is redirected back ──
    if (action === 'confirm_session') {
      const { invoiceId, sessionId } = body;
      if (!invoiceId || !sessionId) return res.status(400).json({ success: false, error: 'Missing invoiceId or sessionId.' });
      const invoice = await getDoc(`invoices/${invoiceId}`);
      if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found.' });
      if (invoice.status === 'paid') return res.status(200).json({ success: true, alreadyPaid: true });
      const key = await getStripeSecretKey(invoice.farrierId);
      if (!key) return res.status(400).json({ success: false, error: 'Farrier payments not configured.' });
      const stripe = new Stripe(key);
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const result = await recordCheckoutSession(stripe, invoice.farrierId, session);
      if (result.invoiceId !== invoiceId) return res.status(400).json({ success: false, error: 'Payment not confirmed by Stripe.' });
      return res.status(200).json({ success: true });
    }

    const caller = await callerFromRequest(req);
    if (!caller) return res.status(401).json({ success: false, error: 'Please sign in again.' });

    // ── Customer portal: pay one or more of your own unpaid invoices ──
    if (action === 'customer_charge') {
      const { invoiceIds = [], paymentMethodId } = body;
      if (!paymentMethodId || !invoiceIds.length) return res.status(400).json({ success: false, error: 'Missing payment details.' });
      const invoices = [];
      for (const id of invoiceIds) {
        const inv = await getDoc(`invoices/${id}`);
        if (!inv || (inv.customerEmail || '').toLowerCase() !== caller.email) return res.status(403).json({ success: false, error: 'Invoice not found.' });
        if (inv.status === 'paid') return res.status(400).json({ success: false, error: `Invoice ${inv.invoiceNumber || id} is already paid.` });
        invoices.push({ id, ...inv });
      }
      const farrierId = invoices[0].farrierId;
      if (invoices.some(i => i.farrierId !== farrierId)) return res.status(400).json({ success: false, error: 'Please pay each farrier separately.' });
      const key = await getStripeSecretKey(farrierId);
      if (!key) return res.status(400).json({ success: false, error: 'Payment not configured. Please contact your farrier.' });
      const stripe = new Stripe(key);
      for (const inv of invoices) { inv.cashCents = P.balanceCents(inv); inv.chargeCents = P.getChargeCents(inv, 'card_link', inv.cashCents); }
      const amountCents = invoices.reduce((s, i) => s + i.chargeCents, 0);
      if (amountCents <= 0) return res.status(400).json({ success: false, error: 'Nothing to pay.' });
      const numbers = invoices.map(i => i.invoiceNumber).filter(Boolean).join(', ');
      const pi = await stripe.paymentIntents.create({
        amount: amountCents, currency: 'usd', payment_method: paymentMethodId, confirm: true,
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        description: `FarriTech Invoice #${numbers}`,
        metadata: { farrierId, invoiceId: invoiceIds.join(','), invoiceNumber: numbers },
        receipt_email: caller.email || undefined,
      });
      if (pi.status !== 'succeeded') return res.status(400).json({ success: false, error: `Payment status: ${pi.status}` });
      const card = await cardDetails(stripe, pi.id);
      for (const inv of invoices) {
        await applyPayment(inv.id, {
          paymentId: invoices.length > 1 ? `${pi.id}_${inv.id}` : pi.id, method: 'card_link',
          amountCents: inv.chargeCents, creditCents: inv.cashCents, source: 'stripe',
          paymentIntentId: pi.id, last4: card.last4, brand: card.brand,
          paidVia: invoices.length > 1 ? 'stripe_card_multi' : 'stripe_card', recordedBy: caller.email,
        });
        await closeOnlinePayment(stripe, inv);
        const ipos = await getIposCreds(farrierId);
        if (ipos) await closeIposPages(ipos, inv.id, inv);
      }
      return res.status(200).json({ success: true, transactionId: pi.id, amount: amountCents / 100, ...card });
    }

    // ── Admin, one-time: move every farrier's legacy key off the public profiles ──
    // (Farriers who log in get migrated automatically via 'status'; this catches the rest.)
    if (action === 'migrate_all') {
      if (!ADMIN_EMAILS.includes(caller.email)) return res.status(403).json({ success: false, error: 'Admins only.' });
      const farriers = await listDocs('farriers', ['stripeSecretKey', 'googleRefreshToken', 'googleAccessToken']);
      let migrated = 0, googleMigrated = 0;
      for (const f of farriers) {
        if (f.stripeSecretKey) { await getStripeSecretKey(f.id); migrated++; }
        if (f.googleRefreshToken || f.googleAccessToken) { await getGoogleRefreshToken(f.id); googleMigrated++; }
      }
      return res.status(200).json({
        success: true, farriers: farriers.length, stripeKeysMigrated: migrated, googleTokensMigrated: googleMigrated,
      });
    }

    // ── Admin: clear a farrier's forgotten manager password so they can set a new one ──
    if (action === 'reset_manager_password') {
      if (!ADMIN_EMAILS.includes(caller.email)) return res.status(403).json({ success: false, error: 'Admins only.' });
      if (!body.farrierId) return res.status(400).json({ success: false, error: 'Missing farrierId.' });
      await patchDoc(`farrierSecrets/${body.farrierId}`, {}, ['managerPasswordHash']);
      return res.status(200).json({ success: true });
    }

    // ── Team (multi-farrier businesses, _lib/team.js) ──
    if (action === 'team_status') return res.status(200).json({ success: true, ...await teamStatus(caller) });
    if (action === 'team_invite') return res.status(200).json({ success: true, ...await teamInvite(caller, body) });
    if (action === 'team_remove') return res.status(200).json({ success: true, ...await teamRemove(caller, body) });
    if (action === 'team_set_role') return res.status(200).json({ success: true, ...await teamSetRole(caller, body) });
    if (action === 'team_accept') return res.status(200).json({ success: true, ...await teamAccept(caller) });

    // Everything below acts on the payment accounts of the business the caller works in: their
    // own (a farrier on their own, or a business owner) or the business they joined. Roles:
    // owner → everything; manager → also refunds and card-price waivers; farrier → takes payments.
    const biz = await businessFor(caller);
    const farrierId = biz.businessId;
    const OWNER_ONLY = ['ipospays_connect', 'ipospays_disconnect', 'connect', 'validate', 'disconnect', 'set_manager_password', 'deactivate_link'];
    const MANAGERS = ['ipospays_refund', 'refund', 'waive_card_price'];
    if (OWNER_ONLY.includes(action)) requireRole(biz, ['owner'], 'change payment settings');
    if (MANAGERS.includes(action)) requireRole(biz, ['owner', 'manager'], action === 'waive_card_price' ? 'waive the card price' : 'issue refunds');

    // ── iPOSpays (Settings → iPOSpays Payments) ──
    if (action === 'ipospays_connect') {
      if (await getStripeSecretKey(farrierId)) throw new PaymentError(ONE_PROCESSOR('Stripe', 'iPOSpays'), 409);
      const { tpn, apiKey, secretKey, ecomToken, mode } = body;
      const result = await connectIpospays(farrierId, { tpn, apiKey, secretKey, ecomToken, mode });
      return res.status(200).json({ success: true, ...result });
    }
    if (action === 'ipospays_disconnect') {
      const result = await disconnectIpospays(farrierId);
      return res.status(200).json({ success: true, ...result });
    }
    if (action === 'ipospays_refund') {
      const { invoiceId, amount, refundPassword } = body;
      const secrets = await getDoc(`farrierSecrets/${farrierId}`);
      if (!secrets?.managerPasswordHash) return res.status(400).json({ success: false, error: 'Set a Manager Password in Settings before issuing refunds.' });
      if (!checkManagerPassword(refundPassword, secrets.managerPasswordHash)) return res.status(403).json({ success: false, error: 'Incorrect manager password.' });
      const ipos = await getIposCreds(farrierId, secrets);
      if (!ipos) return res.status(400).json({ success: false, error: 'iPOSpays isn’t connected. Reconnect it in Settings, or refund in the iPOSpays portal.' });
      const invoice = await ownInvoice(invoiceId, farrierId);
      const result = await refundIposPayment(ipos, invoiceId, invoice, Math.round(parseFloat(amount) * 100));
      return res.status(200).json({ success: true, recorded: true, ...result, amount: result.amountCents / 100 });
    }
    // Keyed card: an iPOSpays payment page for the farrier to type the card into (opened in a
    // new tab by the app), for `applyAmount` of the cash-price balance (default: all of it).
    // The app then asks ipospays_check until iPOSpays says it went through or was declined.
    if (action === 'ipospays_keyed') {
      const { invoiceId, applyAmount } = body;
      const ipos = await getIposCreds(farrierId);
      if (!ipos) return res.status(400).json({ success: false, error: 'iPOSpays isn’t connected. Connect it in Settings → iPOSpays Payments.' });
      const invoice = await ownInvoice(invoiceId, farrierId);
      if (invoice.status === 'paid' || invoice.status === 'cancelled') return res.status(400).json({ success: false, error: `This invoice is ${invoice.status}.` });
      const applyCents = applyAmount ? P.toCents(applyAmount) : 0;
      if (applyAmount && applyCents <= 0) return res.status(400).json({ success: false, error: 'Enter a valid amount.' });
      const { url, ref, chargeCents } = await createIposPage(ipos, invoiceId, invoice, { method: 'card_keyed', applyCents });
      return res.status(200).json({ success: true, url, ref, amount: chargeCents / 100 });
    }
    if (action === 'ipospays_check') {
      const { invoiceId, ref } = body;
      if (!/^[A-Za-z0-9]{1,20}$/.test(String(ref || ''))) return res.status(400).json({ success: false, error: 'Bad reference.' });
      const ipos = await getIposCreds(farrierId);
      if (!ipos) return res.status(400).json({ success: false, error: 'iPOSpays isn’t connected.' });
      await ownInvoice(invoiceId, farrierId);
      const result = await syncIposPayment(ipos, invoiceId, String(ref));
      return res.status(200).json({
        success: true, paid: !!result.paid, declined: !!result.declined, message: result.message || '',
        amount: result.paid ? result.amountCents / 100 : 0, status: result.status || '',
      });
    }
    if (action === 'ipospays_status') {
      const ipos = await getIposCreds(farrierId);
      return res.status(200).json({ success: true, connected: !!ipos, mode: ipos?.mode || '', tpnLast4: ipos ? ipos.tpn.slice(-4) : '' });
    }

    // Pay links go through iPOSpays while it's connected.
    const ipos = ['payment_link', 'waive_card_price'].includes(action) ? await getIposCreds(farrierId) : null;
    if (ipos && action === 'payment_link') {
      const invoice = await ownInvoice(body.invoiceId, farrierId);
      if (invoice.status === 'paid' || invoice.status === 'cancelled') return res.status(400).json({ success: false, error: `This invoice is ${invoice.status}.` });
      const { paymentUrl, chargeCents, cashCents } = await createIposPage(ipos, body.invoiceId, invoice);
      return res.status(200).json({ success: true, paymentUrl, amount: chargeCents / 100, cashAmount: cashCents / 100 });
    }
    if (ipos && action === 'waive_card_price') {
      const { invoiceId, waive = true } = body;
      const invoice = await ownInvoice(invoiceId, farrierId);
      if (invoice.status === 'paid' || invoice.status === 'cancelled') return res.status(400).json({ success: false, error: `This invoice is ${invoice.status}.` });
      const changes = waive
        ? { cardFeeWaived: true, cardFeeWaivedBy: caller.email || caller.uid, cardFeeWaivedAt: new Date() }
        : { cardFeeWaived: false, cardFeeWaivedBy: '', cardFeeWaivedAt: null };
      // createIposPage closes the open page first (and stops if the customer just paid it).
      const updated = { ...invoice, ...changes };
      const { paymentUrl, chargeCents } = await createIposPage(ipos, invoiceId, updated);
      await patchDoc(`invoices/${invoiceId}`, changes);
      const sentVia = await sendUpdatedPayLink(updated, invoiceId, chargeCents);
      return res.status(200).json({ success: true, paymentUrl, amount: chargeCents / 100, sentVia });
    }

    if (action === 'connect' || action === 'validate') {
      const { stripeSecretKey } = body;
      if (!stripeSecretKey || !SECRET_KEY_RE.test(stripeSecretKey)) return res.status(400).json({ success: false, error: 'Secret key must start with sk_live_, sk_test_, rk_live_ or rk_test_' });
      if (await getIposCreds(farrierId)) throw new PaymentError(ONE_PROCESSOR('iPOSpays', 'Stripe'), 409);
      const stripe = new Stripe(stripeSecretKey);
      let accountName = 'Stripe Account';
      try {
        const account = await stripe.accounts.retrieve();
        accountName = account.settings?.dashboard?.display_name || account.email || accountName;
      } catch (e) {
        // Restricted (rk_) keys usually can't read account details; prove the key works
        // with a call the app actually needs (PaymentIntents) instead.
        if (e.type !== 'StripePermissionError') throw e;
        await stripe.paymentIntents.list({ limit: 1 });
      }
      // Each farrier's Stripe account has to tell us when an invoice is paid online.
      await setupWebhook(stripe, farrierId);
      await setStripeSecretKey(farrierId, stripeSecretKey);
      return res.status(200).json({ success: true, accountName });
    }
    if (action === 'disconnect') {
      const oldKey = await getStripeSecretKey(farrierId);
      const oldStripe = oldKey ? new Stripe(oldKey) : null;
      const result = oldStripe ? await closeStripeCheckouts(oldStripe, farrierId) : {};
      await removeWebhook(oldStripe, farrierId);
      await setStripeSecretKey(farrierId, '');
      return res.status(200).json({ success: true, ...result });
    }
    if (action === 'status') {
      const key = await getStripeSecretKey(farrierId); // also migrates a legacy key off the profile
      const secrets = key ? await getDoc(`farrierSecrets/${farrierId}`) : null;
      return res.status(200).json({ success: true, connected: !!key, mode: /^(sk|rk)_live_/.test(key) ? 'live' : key ? 'test' : '', webhookConfigured: !!secrets?.stripeWebhookSecret });
    }

    // ── Record a payment taken outside FarriTech (cash, check, ACH, Zelle, Venmo, card terminal, other) ──
    // Works without Stripe connected; if there is an open online checkout it gets closed so
    // the customer can't pay twice.
    if (action === 'record_payment') {
      const { invoiceId, method, amount, reference = '', datePaid } = body;
      if (!P.MANUAL_METHODS[method]) return res.status(400).json({ success: false, error: 'Pick a payment method.' });
      const invoice = await ownInvoice(invoiceId, farrierId);
      const amountCents = P.toCents(amount);
      if (amountCents <= 0) return res.status(400).json({ success: false, error: 'Enter a valid amount.' });
      const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(datePaid || '')) ? `${datePaid}T17:00:00Z` : datePaid;
      const paidDate = dateStr && !isNaN(new Date(dateStr)) ? new Date(dateStr) : null;
      const result = await applyPayment(invoiceId, {
        method, amountCents,
        reference: String(reference).slice(0, 120), recordedBy: caller.email || caller.uid, paidDate,
      });
      const key = await getStripeSecretKey(farrierId);
      if (key) await closeOnlinePayment(new Stripe(key), invoice);
      const iposCreds = await getIposCreds(farrierId);
      if (iposCreds) await closeIposPages(iposCreds, invoiceId, invoice);
      return res.status(200).json({ success: true, status: result.status, balance: (result.balanceCents || 0) / 100 });
    }

    // ── Manager password (Settings → Manager Password): guards refunds ──
    if (action === 'manager_password_status') {
      const secrets = await getDoc(`farrierSecrets/${farrierId}`);
      return res.status(200).json({ success: true, isSet: !!secrets?.managerPasswordHash });
    }
    if (action === 'set_manager_password') {
      const { currentPassword, newPassword } = body;
      if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ success: false, error: 'New manager password must be at least 6 characters.' });
      const secrets = await getDoc(`farrierSecrets/${farrierId}`);
      if (secrets?.managerPasswordHash && !checkManagerPassword(currentPassword, secrets.managerPasswordHash)) {
        return res.status(403).json({ success: false, error: 'Current manager password is incorrect.' });
      }
      await patchDoc(`farrierSecrets/${farrierId}`, { managerPasswordHash: hashManagerPassword(newPassword), managerPasswordUpdatedAt: new Date() });
      return res.status(200).json({ success: true });
    }

    const key = await getStripeSecretKey(farrierId);
    if (!key) return res.status(400).json({ success: false, error: 'No Stripe account connected. Connect Stripe in Settings → Stripe Payments.' });
    // (iPOSpays farriers' pay links were handled above.)
    const stripe = new Stripe(key);

    // Keyed card payment. `applyAmount` is how much of the (cash-price) balance to pay off —
    // omit it to pay the whole balance. The card price is added here, then the payment is
    // recorded on the invoice before we answer, so the browser never has to write it.
    if (action === 'charge') {
      const { paymentMethodId, invoiceId, applyAmount } = body;
      if (!paymentMethodId || !invoiceId) return res.status(400).json({ success: false, error: 'Missing paymentMethodId or invoiceId.' });
      const invoice = await ownInvoice(invoiceId, farrierId);
      if (invoice.status === 'paid' || invoice.status === 'cancelled') return res.status(400).json({ success: false, error: `This invoice is ${invoice.status}.` });
      const balance = P.balanceCents(invoice);
      const cashCents = applyAmount ? Math.min(P.toCents(applyAmount), balance) : balance;
      if (cashCents <= 0) return res.status(400).json({ success: false, error: 'Nothing is owed on this invoice.' });
      const amountCents = P.getChargeCents(invoice, 'card_keyed', cashCents);
      const priceType = amountCents !== cashCents ? 'card' : 'cash';
      const invoiceNumber = invoice.invoiceNumber || '';
      const customerEmail = invoice.customerEmail || '', customerName = invoice.customerName || '';
      let customerId;
      if (customerEmail) {
        const existing = await stripe.customers.list({ email: customerEmail, limit: 1 });
        customerId = existing.data.length > 0 ? existing.data[0].id : (await stripe.customers.create({ email: customerEmail, name: customerName, metadata: { farrierId, source: 'FarriTech' } })).id;
      }
      if (customerId) await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
      const pi = await stripe.paymentIntents.create({
        amount: amountCents, currency: 'usd', payment_method: paymentMethodId,
        customer: customerId || undefined, confirm: true,
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        description: `FarriTech Invoice #${invoiceNumber}`,
        metadata: { farrierId, invoiceId, invoiceNumber, method: 'card_keyed', priceType, baseCents: String(cashCents), cardCents: String(amountCents) },
        receipt_email: customerEmail || undefined,
      });
      if (pi.status !== 'succeeded') return res.status(400).json({ success: false, error: `Payment status: ${pi.status}` });
      const card = await cardDetails(stripe, pi.id);
      const result = await applyPayment(invoiceId, {
        paymentId: pi.id, method: 'card_keyed', amountCents, creditCents: cashCents, source: 'stripe',
        paymentIntentId: pi.id, last4: card.last4, brand: card.brand, paidVia: 'stripe_card', recordedBy: caller.email || caller.uid,
      });
      await closeOnlinePayment(stripe, invoice);
      return res.status(200).json({ success: true, transactionId: pi.id, amount: amountCents / 100, status: result.status, ...card });
    }

    if (action === 'refund') {
      const { transactionId, amount: refundAmount, refundPassword } = body;
      if (!transactionId) return res.status(400).json({ success: false, error: 'Missing transactionId.' });
      // Refunds need this farrier's manager password (set in Settings; stored hashed server-side).
      const secrets = await getDoc(`farrierSecrets/${farrierId}`);
      if (!secrets?.managerPasswordHash) return res.status(400).json({ success: false, error: 'Set a Manager Password in Settings before issuing refunds.' });
      if (!checkManagerPassword(refundPassword, secrets.managerPasswordHash)) return res.status(403).json({ success: false, error: 'Incorrect manager password.' });
      const refund = await stripe.refunds.create({ payment_intent: transactionId, amount: refundAmount ? Math.round(parseFloat(refundAmount) * 100) : undefined });
      return res.status(200).json({ success: true, refundId: refund.id, amount: refund.amount / 100 });
    }

    // Online pay link for an invoice: a Checkout Session for the balance (card price unless
    // waived) behind the permanent https://app.farritech.com/pay/{invoiceId} link.
    if (action === 'payment_link') {
      const { invoiceId } = body;
      const invoice = await ownInvoice(invoiceId, farrierId);
      if (invoice.status === 'paid' || invoice.status === 'cancelled') return res.status(400).json({ success: false, error: `This invoice is ${invoice.status}.` });
      const { paymentUrl, chargeCents, cashCents, session } = await createCheckoutSession(stripe, invoiceId, invoice);
      return res.status(200).json({ success: true, paymentUrl, checkoutSessionId: session.id, amount: chargeCents / 100, cashAmount: cashCents / 100 });
    }

    // "Waive card price & resend" (waive: true) and "Undo waiver" (waive: false).
    if (action === 'waive_card_price') {
      const { invoiceId, waive = true } = body;
      const invoice = await ownInvoice(invoiceId, farrierId);
      if (invoice.status === 'paid' || invoice.status === 'cancelled') return res.status(400).json({ success: false, error: `This invoice is ${invoice.status}.` });
      if (invoice.checkoutSessionId) {
        const current = await stripe.checkout.sessions.retrieve(invoice.checkoutSessionId).catch(() => null);
        if (current?.status === 'complete') {
          if (current.payment_status === 'paid') await recordCheckoutSession(stripe, farrierId, current);
          return res.status(409).json({ success: false, error: 'Customer already paid by card.' });
        }
      }
      const changes = waive
        ? { cardFeeWaived: true, cardFeeWaivedBy: caller.email || caller.uid, cardFeeWaivedAt: new Date() }
        : { cardFeeWaived: false, cardFeeWaivedBy: '', cardFeeWaivedAt: null };
      await patchDoc(`invoices/${invoiceId}`, changes);
      const updated = { ...invoice, ...changes };
      // createCheckoutSession expires the open session before making the new one.
      const { paymentUrl, chargeCents } = await createCheckoutSession(stripe, invoiceId, updated);
      const sentVia = await sendUpdatedPayLink(updated, invoiceId, chargeCents);
      return res.status(200).json({ success: true, paymentUrl, amount: chargeCents / 100, sentVia });
    }

    if (action === 'deactivate_link') {
      const { paymentLinkId } = body;
      if (!paymentLinkId) return res.status(400).json({ success: false, error: 'Missing paymentLinkId.' });
      await stripe.paymentLinks.update(paymentLinkId, { active: false });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: 'Invalid action.' });
  } catch (err) {
    console.error('stripe-payment error:', err);
    if (err instanceof PaymentError) return res.status(err.status).json({ success: false, error: err.message });
    return res.status(400).json({ success: false, error: err?.raw?.message || err?.message || 'Payment processing failed' });
  }
}
