// iPOSpays (Dejavoo) Hosted Payment Page — the alternative to Stripe Checkout for pay links.
// Docs: https://docs.ipospays.com/hosted-payment-page/api-docs/NotifyByPost
//
// A farrier connects iPOSpays in Settings with four values from their iPOSpays merchant
// portal (all kept in the locked farrierSecrets/{uid} doc, never sent to browsers):
//   ipospaysTpn         CloudPOS TPN (12 digits) — merchantId on every payment page
//   ipospaysApiKey      Settings → Generate API & Secret Key
//   ipospaysSecretKey   (same place)
//   ipospaysEcomToken   Settings → Merchant Keys / Ecom Token — needed for Query Payment Status
// plus ipospaysMode ('sandbox' | 'production'). While iPOSpays is connected, the customer
// pay link /pay/{invoiceId} opens an iPOSpays payment page instead of Stripe Checkout.
//
// A payment is only ever recorded after Query Payment Status says it succeeded. iPOSpays
// tells us something happened two ways — a server POST to /api/ipospays/callback/{invoiceId}
// and the customer's browser coming back to /pay/{invoiceId}?ipos_ref=… — but neither is
// trusted on its own; both just trigger the status check. applyPayment() (keyed by the
// reference id) makes sure whichever arrives second does nothing.
//
// Invoice fields:
//   iposOpenRef            reference id of the payment page currently on offer
//   iposLinks.{ref}        { url, chargeCents, creditCents, method, createdAt } for every page made
//                          (method 'card_keyed' = a page the farrier opened to key in a card)
//   iposTransactionId      iPOSpays transaction id once paid (the Refund button voids or refunds it)
import crypto from 'crypto';
import '../../lib/pricing.js';
import { getDoc, patchDoc, queryIn, serverAuth } from './firebase-rest.js';
import { applyPayment, payUrlFor, PaymentError, APP_URL } from './invoice-payments.js';

const P = globalThis.FarriPricing;

const HOSTS = {
  sandbox: { auth: 'https://auth.ipospays.tech', payment: 'https://payment.ipospays.tech', api: 'https://api.ipospays.tech' },
  production: { auth: 'https://auth.ipospays.com', payment: 'https://payment.ipospays.com', api: 'https://api.ipospays.com' },
};
const hosts = (mode) => HOSTS[mode === 'production' ? 'production' : 'sandbox'];

const TOKEN_MINUTES = 1440;          // longest iPOSpays allows
const TOKEN_REFRESH_MS = 30 * 60e3;  // get a new one this long before it runs out
const LINK_EXPIRY_DAYS = 7;          // iPOSpays allows 1–31; /pay/{id} makes a new page after this
const SECRET_FIELDS = [
  'ipospaysTpn', 'ipospaysApiKey', 'ipospaysSecretKey', 'ipospaysEcomToken', 'ipospaysMode',
  'ipospaysCallbackSecret', 'ipospaysToken', 'ipospaysTokenExpiresAt', 'ipospaysConnectedAt',
];

// Messages for the auth errors a farrier can cause (the rest would be our bug).
const AUTH_ERRORS = {
  AUTH_ERR_004: 'iPOSpays didn’t accept that API key and secret key. Copy them again from the iPOSpays portal → Settings → Generate API & Secret Key.',
  AUTH_ERR_005: 'Those iPOSpays keys aren’t allowed to take payments. Generate them while signed in to your Merchant Admin account.',
};

const alnum = (s, max) => String(s ?? '').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, max);

// 'FT' + 18 random letters/digits: iPOSpays wants alphanumeric, at most 20 characters.
export function newReferenceId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return 'FT' + Array.from(crypto.randomBytes(18), b => chars[b % chars.length]).join('');
}

// US numbers in the +1XXXXXXXXXX form iPOSpays wants; '' if it doesn't look like one.
export function toIposMobile(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return '';
}

// The payment page URL carries its own id in ?t= — Cancel Payment Link needs it.
export function linkToken(url) {
  try { return new URL(url).searchParams.get('t') || ''; } catch (e) { return ''; }
}


async function readJson(r) {
  const text = await r.text();
  try { return JSON.parse(text); } catch (e) { return { raw: text.slice(0, 300) }; }
}

function errorText(d, fallback) {
  if (Array.isArray(d?.errors) && d.errors.length) return d.errors.map(e => e.message || e.field).join('; ');
  return d?.errorMessage || d?.responseMessage || d?.message || fallback;
}

// ── Credentials ──
export async function getIposCreds(farrierId, secrets = null) {
  if (!farrierId) return null;
  const s = secrets || await getDoc(`farrierSecrets/${farrierId}`);
  if (!s?.ipospaysTpn || !s.ipospaysApiKey || !s.ipospaysSecretKey) return null;
  return {
    farrierId,
    tpn: s.ipospaysTpn, apiKey: s.ipospaysApiKey, secretKey: s.ipospaysSecretKey, ecomToken: s.ipospaysEcomToken || '',
    mode: s.ipospaysMode === 'production' ? 'production' : 'sandbox',
    callbackSecret: s.ipospaysCallbackSecret || '',
    token: s.ipospaysToken || '', tokenExpiresAt: Number(s.ipospaysTokenExpiresAt) || 0,
  };
}

// Generate Auth Token. Throws PaymentError with a farrier-friendly message.
// Only these three headers: Dejavoo support confirmed the request takes no scope header.
async function requestToken({ apiKey, secretKey, mode }) {
  const r = await fetch(`${hosts(mode).auth}/v1/authenticate-token`, {
    method: 'POST',
    headers: { apiKey, secretKey, TokenExpiryMinutes: String(TOKEN_MINUTES) },
  });
  const d = await readJson(r);
  if (r.ok && d.responseCode === '00' && d.token) {
    const created = Number(d.createdDt) || Date.now();
    // createdDt is epoch milliseconds; guard against seconds just in case.
    const createdMs = created < 1e12 ? created * 1000 : created;
    return { token: d.token, expiresAt: createdMs + TOKEN_MINUTES * 60e3 };
  }
  console.error('iPOSpays auth failed:', r.status, JSON.stringify(d));
  throw new PaymentError(AUTH_ERRORS[d.errorCode] || `Couldn’t connect to iPOSpays: ${errorText(d, `HTTP ${r.status}`)}${d.errorCode ? ` (${d.errorCode})` : ''}`, 400);
}

// A usable auth token for this farrier — the saved one, or a fresh one (then saved).
async function authToken(creds, { fresh = false } = {}) {
  if (!fresh && creds.token && creds.tokenExpiresAt - TOKEN_REFRESH_MS > Date.now()) return creds.token;
  const { token, expiresAt } = await requestToken(creds);
  creds.token = token; creds.tokenExpiresAt = expiresAt;
  await patchDoc(`farrierSecrets/${creds.farrierId}`, { ipospaysToken: token, ipospaysTokenExpiresAt: expiresAt });
  return token;
}

// ── Connect / disconnect (Settings → iPOSpays Payments) ──
export async function connectIpospays(farrierId, { tpn, apiKey, secretKey, ecomToken, mode }) {
  tpn = String(tpn || '').replace(/\s/g, '');
  apiKey = String(apiKey || '').trim(); secretKey = String(secretKey || '').trim(); ecomToken = String(ecomToken || '').trim();
  mode = mode === 'production' ? 'production' : 'sandbox';
  if (!/^\d{12}$/.test(tpn)) throw new PaymentError('The TPN is the 12-digit number for your CloudPOS terminal in the iPOSpays portal.');
  if (!apiKey || !secretKey) throw new PaymentError('Enter both the API key and the secret key.');
  if (!ecomToken) throw new PaymentError('Enter the Ecom token (iPOSpays portal → Settings → Merchant Keys / Ecom Token).');

  const { token, expiresAt } = await requestToken({ apiKey, secretKey, mode });

  // Prove the Ecom token works: look up a payment that can't exist. A wrong token is
  // refused outright; a good one gets a "not found"-style answer.
  const probe = await fetch(`${hosts(mode).api}/v1/queryPaymentStatus?${new URLSearchParams({ tpn, transactionReferenceId: newReferenceId() })}`, {
    headers: { Authorization: ecomToken },
  }).catch(() => null);
  if (probe && (probe.status === 401 || probe.status === 403)) {
    throw new PaymentError('iPOSpays didn’t accept that Ecom token. In the iPOSpays portal go to Settings → Merchant Keys / Ecom Token, pick this TPN and generate a token.');
  }

  // Prove the account can make payment pages (iPOSpays has to enable PaymentTokenization
  // per merchant): make a $1 page for no invoice, then cancel it straight away.
  const callbackSecret = crypto.randomBytes(24).toString('hex').slice(0, 40);
  const ref = newReferenceId();
  const testPage = pageRequest({ tpn, callbackSecret }, 'connectiontest', { invoiceNumber: 'TEST' }, { businessName: 'FarriTech' }, ref, 100, 100);
  const r = await fetch(`${hosts(mode).payment}/api/v3/external-payment-transaction`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', token }, body: JSON.stringify(testPage),
  }).catch(() => null);
  const d = r ? await readJson(r) : {};
  if (!r || !r.ok || !d.information) {
    console.error('iPOSpays test page failed:', r?.status, JSON.stringify(d));
    throw new PaymentError(`Your keys work, but iPOSpays won’t make payment pages for this account yet: ${errorText(d, r ? `HTTP ${r.status}` : 'no response').replace(/\.+$/, '')}. Ask iPOSpays (devsupport@dejavoo.io) or your ISO to enable PaymentTokenization / Hosted Payment Page for TPN ${tpn}.`);
  }
  const t = linkToken(d.information);
  if (t) await fetch(`${hosts(mode).payment}/api/v1/cancel`, { method: 'POST', headers: { Authorization: t } }).catch(() => null);

  await patchDoc(`farrierSecrets/${farrierId}`, {
    ipospaysTpn: tpn, ipospaysApiKey: apiKey, ipospaysSecretKey: secretKey, ipospaysEcomToken: ecomToken, ipospaysMode: mode,
    ipospaysCallbackSecret: callbackSecret,
    ipospaysToken: token, ipospaysTokenExpiresAt: expiresAt, ipospaysConnectedAt: new Date(),
  });
  return { mode, tpnLast4: tpn.slice(-4) };
}

// Pages already sent stay payable at iPOSpays for up to LINK_EXPIRY_DAYS, and once the keys
// are gone a payment on one can't be confirmed (or refunded) here. So close every open page
// first (recording any that were just paid), and keep the keys if one can't be closed.
export async function disconnectIpospays(farrierId) {
  const creds = await getIposCreds(farrierId);
  let closed = 0, paid = 0;
  if (creds) {
    const open = (await queryIn('invoices', 'farrierId', [farrierId])).filter(inv => inv.iposOpenRef);
    const failed = [];
    for (let i = 0; i < open.length; i += 5) {
      await Promise.all(open.slice(i, i + 5).map(async (inv) => {
        try {
          const result = await closeIposPages(creds, inv.id, inv);
          if (result.paid) paid++;
          else if (result.closed === false) failed.push(inv.invoiceNumber || inv.id);
          else closed++;
        } catch (e) {
          console.error('iPOSpays disconnect: could not close page', inv.id, e);
          failed.push(inv.invoiceNumber || inv.id);
        }
      }));
    }
    if (failed.length) {
      throw new PaymentError(`iPOSpays is still connected: couldn’t close the payment page for invoice${failed.length > 1 ? 's' : ''} #${failed.join(', #')}. Try again in a minute.`, 502);
    }
  }
  await patchDoc(`farrierSecrets/${farrierId}`, {}, SECRET_FIELDS);
  return { closed, paid };
}

// ── Payment pages ──
function pageRequest(creds, invoiceId, invoice, farrier, ref, chargeCents, cashCents) {
  const number = alnum(invoice.invoiceNumber || invoiceId, 25);
  const email = String(invoice.customerEmail || '').trim();
  return {
    merchantAuthentication: { merchantId: creds.tpn, transactionReferenceId: ref },
    transactionRequest: {
      transactionType: 1,
      amount: String(chargeCents),
      // FarriTech already worked out the price (card price included) — iPOSpays adds nothing.
      calculateFee: false,
      calculateTax: false,
      tipsInputPrompt: false,
      expiry: LINK_EXPIRY_DAYS,
      txReferenceTag1: { tagLabel: 'Invoice', tagValue: number, isTagMandate: false },
    },
    notificationOption: {
      notifyByPOST: true,
      postAPI: `${new URL(payUrlFor(invoiceId)).origin}/api/ipospays/callback/${invoiceId}?ref=${ref}`,
      authHeader: creds.callbackSecret,
      notifyByRedirect: true,
      returnUrl: `${payUrlFor(invoiceId)}?ipos_ref=${ref}`,
      failureUrl: `${payUrlFor(invoiceId)}?ipos_ref=${ref}`,
      cancelUrl: `${payUrlFor(invoiceId)}?canceled=1`,
    },
    preferences: {
      integrationType: 3, // Quick pay / Send link
      avsVerification: false,
      eReceipt: false,    // FarriTech sends its own "payment received" text
      eReceiptInputPrompt: false,
      customerName: alnum(invoice.customerName, 25),
      customerEmail: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : '',
      customerMobile: toIposMobile(invoice.customerPhone),
      sendPaymentLink: false, // FarriTech texts/emails /pay/{id} itself
      requestCardToken: true, // kept on the payment record in case a refund or void is ever needed
      shortenURL: false,
      integrationVersion: 'v2',
    },
    personalization: {
      // iPOSpays refuses symbols in these fields ("$", "." in the button text gave
      // "Invalid pay button text"), so keep them to letters, digits and spaces.
      merchantName: alnum(farrier?.businessName, 35) || 'Your Farrier',
      description: alnum(`Invoice ${number}` + (chargeCents !== cashCents ? ' card price' : ''), 150),
      payNowButtonText: 'Pay Now',
    },
  };
}

// Makes a new iPOSpays payment page for what's owed (card price unless waived), after
// closing the one currently on offer. Returns { url, ref, chargeCents, cashCents }.
// A keyed card payment (method 'card_keyed') is the same page, opened on the farrier's own
// screen so they can type the card in; `applyCents` pays off only part of the balance.
// The card number goes straight to iPOSpays and never passes through FarriTech.
export async function createIposPage(creds, invoiceId, invoice, { method = 'card_link', applyCents = 0 } = {}) {
  const balance = P.balanceCents(invoice);
  const cashCents = applyCents > 0 ? Math.min(applyCents, balance) : balance;
  if (cashCents <= 0) throw new PaymentError('Nothing is owed on this invoice.');
  const chargeCents = P.getChargeCents(invoice, method, cashCents);

  const closed = await closeIposPages(creds, invoiceId, invoice);
  if (closed.paid) throw new PaymentError('Customer already paid by card.', 409);

  const farrier = await getDoc(`farriers/${invoice.farrierId}`).catch(() => null);
  const ref = newReferenceId();
  const body = JSON.stringify(pageRequest(creds, invoiceId, invoice, farrier, ref, chargeCents, cashCents));
  const send = async (token) => fetch(`${hosts(creds.mode).payment}/api/v3/external-payment-transaction`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', token }, body,
  });
  let r = await send(await authToken(creds));
  let d = await readJson(r);
  // A token revoked early, or one saved before the scope header was dropped (iPOSpays
  // answers those with "not registered for PaymentTokenization"): get a new one, once.
  if (r.status === 401 || (!d.information && /PaymentTokenization/i.test(errorText(d, '')))) {
    r = await send(await authToken(creds, { fresh: true }));
    d = await readJson(r);
  }
  if (!r.ok || !d.information) {
    console.error('iPOSpays payment page failed:', invoiceId, r.status, JSON.stringify(d));
    throw new PaymentError(`iPOSpays couldn’t make the payment page: ${errorText(d, `HTTP ${r.status}`)}`, 400);
  }

  // Keep the last few pages: a callback for an older one can still arrive.
  const links = Object.fromEntries(Object.entries(invoice.iposLinks || {})
    .sort((a, b) => new Date(b[1]?.createdAt) - new Date(a[1]?.createdAt)).slice(0, 9));
  links[ref] = { url: d.information, chargeCents, creditCents: cashCents, method, createdAt: new Date() };
  const paymentUrl = payUrlFor(invoiceId);
  await patchDoc(`invoices/${invoiceId}`, {
    iposOpenRef: ref,
    iposLinks: links,
    priceType: chargeCents !== cashCents ? 'card' : 'cash',
    paymentUrl,
    paymentLinkUrl: paymentUrl,
    updatedAt: new Date(),
  });
  return { url: d.information, ref, chargeCents, cashCents, paymentUrl };
}

// The page on offer, if it's still good for `chargeCents` (so /pay/{id} can reuse it).
export function reusableIposPage(invoice, chargeCents) {
  const link = invoice.iposOpenRef && invoice.iposLinks?.[invoice.iposOpenRef];
  if (!link?.url || link.chargeCents !== chargeCents || link.method === 'card_keyed') return null;
  const age = Date.now() - new Date(link.createdAt).getTime();
  return age < (LINK_EXPIRY_DAYS - 1) * 86400e3 ? link.url : null;
}

// ── Payment status ──
// Query Payment Status. Returns iposHPResponse, or null if iPOSpays has nothing (yet).
export async function queryIposPayment(creds, ref) {
  const url = `${hosts(creds.mode).api}/v1/queryPaymentStatus?${new URLSearchParams({ tpn: creds.tpn, transactionReferenceId: ref })}`;
  const ask = async (label, headers) => {
    const r = await fetch(url, { headers }).catch(() => null);
    const d = r ? await readJson(r) : {};
    console.log(`iPOSpays status (${label}):`, ref, r?.status, JSON.stringify(d).replace(/("cardToken":")[^"]*/g, '$1[hidden]').slice(0, 1500));
    if (!r?.ok) return null;
    // Sandbox answers { status: 'Success', data: {...} } ({ status: 'Pending', data: {} } before
    // the payment settles); the docs show { iposHPResponse: {...} }.
    const resp = d.iposHPResponse || d.data?.iposHPResponse || d.data || d;
    return resp?.responseCode !== undefined && resp?.responseCode !== '' ? resp : null;
  };
  // The docs show the Ecom token as the Authorization header. If that gets no answer,
  // try the auth token the payment page was made with.
  return await ask('ecom token', { Authorization: creds.ecomToken })
    || await ask('auth token', { token: await authToken(creds).catch(() => '') });
}

const succeeded = (resp) => resp && Number(resp.responseCode) === 200 && String(resp.transactionReferenceId || '') !== '';

// Checks one reference id with iPOSpays and records the payment if it went through.
// Returns { paid, declined?, message?, ...applyPayment result }.
export async function syncIposPayment(creds, invoiceId, ref) {
  const invoice = await getDoc(`invoices/${invoiceId}`);
  const link = invoice?.iposLinks?.[ref];
  if (!invoice || invoice.farrierId !== creds.farrierId || !link) return { paid: false, ignored: 'unknown reference' };

  const resp = await queryIposPayment(creds, ref);
  if (!resp) return { paid: false };
  if (!succeeded(resp) || resp.transactionReferenceId !== ref) {
    // iPOSpays has an answer and it isn't an approval (e.g. a decline for a CVV mismatch).
    // That page can't be used again ("link expired"), so the next try makes a new one.
    if (invoice.iposOpenRef === ref) await patchDoc(`invoices/${invoiceId}`, { iposOpenRef: '' });
    return { paid: false, declined: true, message: resp.errResponseMessage || resp.responseMessage || '' };
  }

  // iPOSpays reports amounts in cents ("103" for $1.03), like the amount we sent.
  const reported = Math.round(Number(resp.totalAmount || resp.amount));
  const amountCents = reported > 0 ? reported : link.chargeCents;
  if (amountCents !== link.chargeCents) console.warn('iPOSpays amount differs from the page:', invoiceId, ref, amountCents, link.chargeCents);
  const last4 = String(resp.cardLast4Digit ?? '').replace(/\D/g, '').slice(-4);
  const brand = resp.cardType ? String(resp.cardType).charAt(0).toUpperCase() + String(resp.cardType).slice(1).toLowerCase() : 'Card';
  const keyed = link.method === 'card_keyed';
  const result = await applyPayment(invoiceId, {
    paymentId: `ipos_${ref}`,
    method: keyed ? 'card_keyed' : 'card_link',
    amountCents,
    creditCents: link.creditCents,
    source: 'ipospays',
    reference: `iPOSpays ${resp.transactionId || ref}`,
    last4, brand: last4 ? brand : '',
    paidVia: keyed ? 'ipospays_keyed' : 'ipospays_link',
    processorDetails: {
      processor: 'ipospays',
      referenceId: ref,
      transactionId: String(resp.transactionId || ''),
      rrn: String(resp.rrn || ''),
      batchNumber: String(resp.batchNumber || ''),
      approvalCode: String(resp.responseApprovalCode || '').trim(),
      // The docs don't name the token field on the status answer; take whichever is there.
      cardToken: String(resp.cardToken || resp.paymentToken || resp.cardTokenId || resp.token || ''),
    },
  });
  if (!result.duplicate) {
    await patchDoc(`invoices/${invoiceId}`, {
      iposTransactionId: String(resp.transactionId || ''),
      ...(invoice.iposOpenRef === ref ? { iposOpenRef: '' } : {}),
    });
    if (!result.alreadyPaid) await sendPaidSms(invoice, amountCents);
  }
  return { paid: true, amountCents, invoice, ...result };
}

// ── Refunds (iPOS Transact, by the original payment's RRN) ──
// Same-day payments are voided (nothing reaches the card statement); once the batch has
// settled a void is declined and a refund is sent instead. A partial amount can only be a
// refund. Records the refund on the invoice the way Stripe refunds are recorded.
export async function refundIposPayment(creds, invoiceId, invoice, cents) {
  const paid = (Array.isArray(invoice.payments) ? invoice.payments : []).filter(p => String(p.paymentId || '').startsWith('ipos_'));
  const payment = paid[paid.length - 1];
  if (!payment) throw new PaymentError('No iPOSpays payment on this invoice.');
  const paidCents = Math.round((payment.amount || 0) * 100);
  const already = (Array.isArray(invoice.refunds) ? invoice.refunds : [])
    .filter(r => r.transactionId === payment.paymentId).reduce((s, r) => s + Math.round((r.amount || 0) * 100), 0);
  const left = paidCents - already;
  if (!Number.isInteger(cents) || cents <= 0) throw new PaymentError('Enter a refund amount.');
  if (cents > left) throw new PaymentError(`Refund can't be more than ${P.money(left)}.`);

  // The RRN saved with the payment, or (payments from before it was saved) iPOSpays' own answer.
  const doc = await getDoc(`invoices/${invoiceId}/payments/${payment.paymentId}`).catch(() => null);
  let rrn = doc?.processorDetails?.rrn || '';
  if (!rrn) rrn = String((await queryIposPayment(creds, payment.paymentId.slice(5)))?.rrn || '');
  if (!/^\d{12}$/.test(rrn)) throw new PaymentError('Couldn’t find this payment in iPOSpays. Refund it in the iPOSpays portal instead.');

  const send = async (transactionType, amount) => {
    const body = {
      merchantAuthentication: { merchantId: creds.tpn, transactionReferenceId: newReferenceId() },
      transactionRequest: { transactionType, rrn, amount }, // '' = the whole original amount (never '0')
    };
    const r = await fetch(`${hosts(creds.mode).payment}/api/v3/iposTransact`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', token: await authToken(creds) }, body: JSON.stringify(body),
    }).catch(() => null);
    const d = r ? await readJson(r) : {};
    console.log(`iPOSpays ${transactionType === 2 ? 'void' : 'refund'}:`, invoiceId, rrn, r?.status, JSON.stringify(d).slice(0, 800));
    const resp = d.iposhpresponse || d.iposHPResponse || d.data || d;
    return { ok: !!r?.ok && Number(resp?.responseCode) === 200, resp, d, status: r?.status };
  };

  // Void only while the payment is still in the open batch. A void request on a settled
  // payment isn't declined: iPOSpays approves it and runs a refund (sandbox, 2026-10-13), and
  // its answer just echoes transactionType 2, so the batch has to be checked first.
  const full = cents === left && already === 0;
  const unsettled = full ? await inOpenBatch(creds, rrn) : false;
  let kind = 'refund';
  let result = null;
  if (unsettled) {
    result = await send(2, '');
    if (result.ok) kind = 'void';
  }
  if (!result?.ok) result = await send(3, full ? '' : String(cents));
  if (!result.ok) {
    const why = result.resp?.errResponseMessage || result.resp?.responseMessage || errorText(result.d, result.status ? `HTTP ${result.status}` : 'no response');
    throw new PaymentError(`iPOSpays didn’t take the refund: ${why}. You can refund it in the iPOSpays portal instead.`, 400);
  }

  const fresh = await getDoc(`invoices/${invoiceId}`);
  const refunds = [...(Array.isArray(fresh.refunds) ? fresh.refunds : []), {
    amount: cents / 100, refundId: String(result.resp.transactionId || ''), transactionId: payment.paymentId,
    processor: 'ipospays', kind, rrn: String(result.resp.rrn || ''), date: new Date().toISOString(),
  }];
  const refundedAmount = refunds.reduce((s, r) => s + (r.amount || 0), 0);
  const paidTotal = fresh.paidAmount || (fresh.payments || []).reduce((s, p) => s + (p.amount || 0), 0) || fresh.total || 0;
  const fully = refundedAmount >= paidTotal - 0.001;
  await patchDoc(`invoices/${invoiceId}`, {
    refunds, refundedAmount, updatedAt: new Date(),
    ...(fully ? { status: 'refunded', refundedAt: new Date() } : {}),
  });
  return { kind, amountCents: cents, refundId: String(result.resp.transactionId || '') };
}

// Is the payment with this RRN still in the merchant's open (unsettled) batch, and not voided?
// iPOS Transact "openbatch" (transactionType 9) lists it under batch_profiles[].batch_details[].
// Any failure counts as "no", so the payment gets a refund rather than a void.
async function inOpenBatch(creds, rrn) {
  try {
    const r = await fetch(`${hosts(creds.mode).payment}/api/v3/iposTransact`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', token: await authToken(creds) },
      body: JSON.stringify({
        merchantAuthentication: { merchantId: creds.tpn, transactionReferenceId: newReferenceId() },
        transactionRequest: { transactionType: 9 },
      }),
    });
    const d = await readJson(r);
    const batch = d.iposhpresponse || d.iposHPResponse || d.data || d;
    const details = (batch?.batch_profiles || []).flatMap(p => p?.batch_details || []);
    const found = details.find(t => String(t?.rrn || '') === rrn);
    console.log('iPOSpays open batch:', r.status, details.length, 'transactions, payment', found ? `found (voidFlag ${found.voidFlag})` : 'not found');
    return !!found && String(found.voidFlag || 'N').toUpperCase() !== 'Y';
  } catch (e) {
    console.warn('iPOSpays open batch check failed:', e.message);
    return false;
  }
}

// Closes every payment page still on offer for the invoice, so the customer can't pay
// for something that's already settled. Any page that turns out to be paid is recorded
// instead — then { paid: true }. If iPOSpays can't be reached to cancel the page, it's
// left on offer and { closed: false } comes back.
export async function closeIposPages(creds, invoiceId, invoice) {
  const ref = invoice.iposOpenRef;
  const link = ref && invoice.iposLinks?.[ref];
  if (!link) return { paid: false };
  const synced = await syncIposPayment(creds, invoiceId, ref);
  if (synced.paid) return { paid: true };
  const t = linkToken(link.url);
  if (t) {
    const r = await fetch(`${hosts(creds.mode).payment}/api/v1/cancel`, { method: 'POST', headers: { Authorization: t } }).catch(() => null);
    if (!r) {
      console.warn('iPOSpays cancel got no response:', invoiceId, ref);
      return { paid: false, closed: false };
    }
    if (!r.ok) {
      // Can't cancel a page that was paid a moment ago — look once more.
      const again = await syncIposPayment(creds, invoiceId, ref);
      if (again.paid) return { paid: true };
      console.warn('iPOSpays cancel failed:', invoiceId, ref, r.status, JSON.stringify(await readJson(r)));
    }
  }
  await patchDoc(`invoices/${invoiceId}`, { iposOpenRef: '' });
  return { paid: false, closed: true };
}

// ── Callback: POST /api/ipospays/callback/{invoiceId}?ref=… ──
// Only a nudge: the payment is confirmed with Query Payment Status before it's recorded.
export async function iposCallback(req, res, rawBody, invoiceId) {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(invoiceId)) return res.status(400).json({ error: 'Bad invoice id' });
  let body = {};
  try { body = JSON.parse(rawBody.toString() || '{}'); } catch (e) { /* not JSON */ }
  const ref = String(req.query?.ref || body?.iposHPResponse?.transactionReferenceId || body?.transactionReferenceId || '');
  if (!/^[A-Za-z0-9]{1,20}$/.test(ref)) return res.status(400).json({ error: 'Bad reference' });
  try {
    const invoice = await getDoc(`invoices/${invoiceId}`);
    const creds = invoice && await getIposCreds(invoice.farrierId);
    if (!creds) return res.status(404).json({ error: 'Not found' });
    const auth = String(req.headers?.authorization || req.headers?.authheader || '').replace(/^Bearer\s+/i, '');
    if (creds.callbackSecret && auth && !safeEqual(auth, creds.callbackSecret)) {
      console.warn('iPOSpays callback with wrong auth header for', invoiceId);
    }
    const result = await syncIposPayment(creds, invoiceId, ref);
    console.log(`📥 iPOSpays callback ${ref} for ${invoiceId}:`, JSON.stringify({ paid: result.paid, status: result.status, duplicate: result.duplicate, ignored: result.ignored }));
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('❌ iPOSpays callback error:', invoiceId, err);
    return res.status(500).json({ error: 'Callback failed' });
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function sendPaidSms(invoice, amountCents) {
  if (!invoice.customerPhone) return;
  try {
    const { idToken } = await serverAuth();
    const name = String(invoice.customerName || '').split(' ')[0] || 'there';
    await fetch(`${APP_URL}/api/send-sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ to: invoice.customerPhone, body: `Hi ${name}, your payment of ${P.money(amountCents)} for invoice #${invoice.invoiceNumber || ''} has been received. Thank you! Reply STOP to opt out.` }),
    });
  } catch (e) { console.warn('Confirmation SMS error:', e.message); }
}
