// Kadima Payments hosted payment form — the third card processor, next to Stripe and iPOSpays.
// API reference: Kadima Payments Postman collection (Merchants → Card Payments / Hosted Form).
//
// A farrier connects Kadima in Settings with three values from their Kadima dashboard (kept in
// the locked farrierSecrets/{uid} doc, never sent to browsers):
//   kadimaToken        Developers → Tokens (needs "Credit/Debit Card Payments Read and Write")
//   kadimaTerminalId   Gateway → Terminals, the "Terminal ID" column (not the TID)
//   kadimaDbaId        the #number on the merchant profile
// plus kadimaMode ('sandbox' | 'production'). While Kadima is connected, /pay/{invoiceId},
// pay links and keyed cards use Kadima's hosted payment form instead of Stripe Checkout.
//
// What we learned from the sandbox (2026-11-17) and why this file trusts nothing it is handed:
// - The form link signs only the merchant/terminal settings. `amount` and `externalId` ride
//   along as plain query parameters, so a customer could edit them.
// - The customer comes back to `returnUrl?id=…&externalId=…&status=…&amount=…`, also unsigned.
// So a payment is only recorded after GET /payments?filter[externalId][eq]={ref} on the
// farrier's own gateway account says it was approved and captured on their terminal, and it is
// recorded for the amount Kadima actually charged (an underpayment leaves the rest owing).
// Kadima forms can't be cancelled, so each one gets a fresh reference id and every recent
// reference is checked before a new form is offered.
//
// Invoice fields:
//   kadimaOpenRef          reference id (our externalId) of the form currently on offer
//   kadimaLinks.{ref}      { url, chargeCents, creditCents, method, createdAt } for every form made
//   kadimaTransactionId    Kadima payment id once paid (the Refund button refunds/voids it)
import crypto from 'crypto';
import '../../lib/pricing.js';
import { getDoc, patchDoc, queryIn, serverAuth } from './firebase-rest.js';
import { applyPayment, payUrlFor, PaymentError, APP_URL } from './invoice-payments.js';

const P = globalThis.FarriPricing;

export const KADIMA_HOSTS = {
  sandbox: { gateway: 'https://sandbox-gateway.kadimadashboard.com', api: 'https://sandbox.kadimadashboard.com' },
  production: { gateway: 'https://gateway.kadimadashboard.com', api: 'https://kadimadashboard.com' },
};
const hosts = (mode) => KADIMA_HOSTS[mode === 'production' ? 'production' : 'sandbox'];

const TIMEOUT_MS = 20_000;
const REUSE_DAYS = 6;      // /pay/{id} makes a fresh form after this (Kadima forms don't expire)
const KEEP_LINKS = 10;     // forms remembered per invoice, so an older one can still be confirmed
const SECRET_FIELDS = ['kadimaToken', 'kadimaTerminalId', 'kadimaDbaId', 'kadimaMode', 'kadimaConnectedAt'];

// 'FT' + 18 random letters/digits: our externalId for one form.
export function newKadimaRef() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return 'FT' + Array.from(crypto.randomBytes(18), b => chars[b % chars.length]).join('');
}
export const isKadimaRef = (ref) => /^FT[A-Za-z0-9]{18}$/.test(String(ref || ''));

const toAmount = (cents) => Number((cents / 100).toFixed(2));
const toCentsSafe = (v) => Math.round(Number(v) * 100);

// Card brand from the BIN (Kadima's gateway answer has the BIN but not the brand).
export function brandFromBin(bin) {
  const b = String(bin || '');
  if (/^4/.test(b)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(b)) return 'Mastercard';
  if (/^3[47]/.test(b)) return 'Amex';
  if (/^(6011|65|64[4-9])/.test(b)) return 'Discover';
  return 'Card';
}

// ── HTTP ──
async function kadimaFetch(creds, base, method, path, { query, body } = {}) {
  const url = new URL(hosts(creds.mode)[base] + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== '') url.searchParams.append(k, String(v));
  let r;
  try {
    r = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${creds.token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    console.error('Kadima request failed:', method, path, e.message);
    return { ok: false, status: 0, data: null };
  }
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 300) }; }
  return { ok: r.ok, status: r.status, data };
}

const errorText = (d, fallback) => (d && (d.message || d.name)) || fallback;

// ── Credentials ──
export async function getKadimaCreds(farrierId, secrets = null) {
  if (!farrierId) return null;
  const s = secrets || await getDoc(`farrierSecrets/${farrierId}`);
  if (!s?.kadimaToken || !s.kadimaTerminalId || !s.kadimaDbaId) return null;
  return {
    farrierId,
    token: s.kadimaToken,
    terminalId: Number(s.kadimaTerminalId),
    dbaId: Number(s.kadimaDbaId),
    mode: s.kadimaMode === 'production' ? 'production' : 'sandbox',
  };
}

// ── Connect / disconnect (Settings → Kadima Payments) ──
export async function connectKadima(farrierId, { token, terminalId, dbaId, mode }) {
  token = String(token || '').trim();
  terminalId = String(terminalId ?? '').trim();
  dbaId = String(dbaId ?? '').replace(/^#/, '').trim();
  mode = mode === 'production' ? 'production' : 'sandbox';
  if (!token) throw new PaymentError('Paste your Kadima API token (Kadima dashboard → Developers → Tokens → View Token).');
  if (!/^\d{1,10}$/.test(terminalId)) throw new PaymentError('The Terminal ID is the number in the "Terminal ID" column under Gateway in your Kadima dashboard (not the TID).');
  if (!/^\d{1,10}$/.test(dbaId)) throw new PaymentError('The DBA ID is the #number shown on your merchant profile in the Kadima dashboard.');
  const creds = { farrierId, token, terminalId: Number(terminalId), dbaId: Number(dbaId), mode };
  const where = mode === 'production' ? 'live' : 'sandbox (test)';

  // 1. The token works on the payment gateway (a read; nothing is charged).
  const probe = await kadimaFetch(creds, 'gateway', 'GET', '/payments', { query: { 'per-page': 1 } });
  if (probe.status === 401) throw new PaymentError(`Kadima didn’t accept that API token for the ${where} gateway. Copy it again from Developers → Tokens → View Token, and check Test/Live matches the dashboard you got it from.`);
  if (probe.status === 403) throw new PaymentError('That Kadima token can’t take card payments. In Developers → Tokens add the permission "Credit/Debit Card Payments Read and Write".');
  if (!probe.ok) throw new PaymentError(`Couldn’t reach Kadima: ${errorText(probe.data, probe.status ? `HTTP ${probe.status}` : 'no response')}`, 502);

  // 2. It can make hosted payment forms for this DBA + terminal. Making a form charges nothing
  //    and no one is sent this one.
  const form = await kadimaFetch(creds, 'api', 'POST', '/api/gateway/hosted-form', {
    body: { dba: { id: creds.dbaId }, terminal: { id: creds.terminalId }, threeds: 'Disabled', amount: 1, externalId: 'FTCONNECTTEST', origin: 'FarriTech', returnUrl: APP_URL },
  });
  if (form.status === 401 || form.status === 403) throw new PaymentError('Your token works for payments, but Kadima won’t let it make payment pages. Use a token with "Credit/Debit Card Payments Read and Write".');
  if (!form.ok || !form.data?.url) {
    console.error('Kadima connect: hosted form failed', form.status, JSON.stringify(form.data).slice(0, 500));
    throw new PaymentError(`Kadima didn’t accept that Terminal ID / DBA ID: ${errorText(form.data, `HTTP ${form.status}`)}. Check both numbers in your Kadima dashboard.`);
  }

  await patchDoc(`farrierSecrets/${farrierId}`, {
    kadimaToken: token, kadimaTerminalId: creds.terminalId, kadimaDbaId: creds.dbaId, kadimaMode: mode, kadimaConnectedAt: new Date(),
  });
  return { mode, terminalId: creds.terminalId, dbaId: creds.dbaId };
}

// Kadima forms can't be cancelled, so before the token is dropped, record any open form the
// customer already paid (afterwards such payments couldn't be confirmed here — they'd still
// be in the farrier's Kadima account).
export async function disconnectKadima(farrierId) {
  const creds = await getKadimaCreds(farrierId);
  let paid = 0;
  if (creds) {
    const open = (await queryIn('invoices', 'farrierId', [farrierId])).filter(i => i.kadimaOpenRef);
    for (const inv of open) {
      try {
        const r = await syncKadimaPayment(creds, inv.id, inv.kadimaOpenRef);
        if (r.paid) paid++;
        else await patchDoc(`invoices/${inv.id}`, { kadimaOpenRef: '' });
      } catch (e) { console.warn('Kadima disconnect: check failed', inv.id, e.message); }
    }
  }
  await patchDoc(`farrierSecrets/${farrierId}`, {}, SECRET_FIELDS);
  return { paid };
}

// ── Payment forms ──
// Makes a Kadima hosted payment form for what's owed (card price unless waived). `card_keyed`
// is the same form shown on the farrier's own screen; `applyCents` pays off part of the balance.
// The card number goes straight to Kadima and never passes through FarriTech.
export async function createKadimaPage(creds, invoiceId, invoice, { method = 'card_link', applyCents = 0 } = {}) {
  const balance = P.balanceCents(invoice);
  const cashCents = applyCents > 0 ? Math.min(applyCents, balance) : balance;
  if (cashCents <= 0) throw new PaymentError('Nothing is owed on this invoice.');
  const chargeCents = P.getChargeCents(invoice, method, cashCents);

  const closed = await closeKadimaPages(creds, invoiceId, invoice);
  if (closed.paid) throw new PaymentError('Customer already paid by card.', 409);

  const ref = newKadimaRef();
  const r = await kadimaFetch(creds, 'api', 'POST', '/api/gateway/hosted-form', {
    body: {
      dba: { id: creds.dbaId },
      terminal: { id: creds.terminalId },
      threeds: 'Disabled',
      amount: toAmount(chargeCents),   // FarriTech already worked out the price; no Kadima fee
      externalId: ref,
      origin: 'FarriTech',
      // Kadima appends "?id=…&externalId=…&status=…" itself, so no query string of our own.
      returnUrl: payUrlFor(invoiceId),
      // Keyed cards run in a frame inside FarriTech: stay in it. Customers: whole window.
      returnUrlNavigation: method === 'card_keyed' ? 'self' : 'top',
      sendReceipt: 'No',               // FarriTech texts its own "payment received"
    },
  });
  if (!r.ok || !r.data?.url) {
    console.error('Kadima hosted form failed:', invoiceId, r.status, JSON.stringify(r.data).slice(0, 500));
    throw new PaymentError(`Kadima couldn’t make the payment page: ${errorText(r.data, r.status ? `HTTP ${r.status}` : 'no response')}`, 400);
  }

  const links = Object.fromEntries(Object.entries(invoice.kadimaLinks || {})
    .sort((a, b) => new Date(b[1]?.createdAt) - new Date(a[1]?.createdAt)).slice(0, KEEP_LINKS - 1));
  links[ref] = { url: r.data.url, chargeCents, creditCents: cashCents, method, createdAt: new Date() };
  const paymentUrl = payUrlFor(invoiceId);
  await patchDoc(`invoices/${invoiceId}`, {
    kadimaOpenRef: ref,
    kadimaLinks: links,
    priceType: chargeCents !== cashCents ? 'card' : 'cash',
    paymentUrl,
    paymentLinkUrl: paymentUrl,
    updatedAt: new Date(),
  });
  return { url: r.data.url, ref, chargeCents, cashCents, paymentUrl };
}

// The form on offer, if it's still good for `chargeCents` (so /pay/{id} can reuse it).
export function reusableKadimaPage(invoice, chargeCents) {
  const link = invoice.kadimaOpenRef && invoice.kadimaLinks?.[invoice.kadimaOpenRef];
  if (!link?.url || link.chargeCents !== chargeCents || link.method === 'card_keyed') return null;
  const age = Date.now() - new Date(link.createdAt).getTime();
  return age < REUSE_DAYS * 86400e3 ? link.url : null;
}

// Stops offering the open form (Kadima has no cancel). If the customer already paid it, that
// payment is recorded and { paid: true } comes back.
export async function closeKadimaPages(creds, invoiceId, invoice) {
  const ref = invoice.kadimaOpenRef;
  if (!ref || !invoice.kadimaLinks?.[ref]) return { paid: false };
  const synced = await syncKadimaPayment(creds, invoiceId, ref);
  if (synced.paid) return { paid: true };
  await patchDoc(`invoices/${invoiceId}`, { kadimaOpenRef: '' });
  return { paid: false, closed: true };
}

// ── Payment status ──
// Kadima's own record of payments made with our reference id, or null if it couldn't be asked.
export async function findKadimaPayments(creds, ref) {
  const r = await kadimaFetch(creds, 'gateway', 'GET', '/payments', { query: { 'filter[externalId][eq]': ref } });
  if (!r.ok) {
    console.warn('Kadima payment lookup failed:', ref, r.status, JSON.stringify(r.data).slice(0, 300));
    return null;
  }
  return Array.isArray(r.data?.items) ? r.data.items : [];
}

const approved = (t) => t?.status?.status === 'Approved' && t.captured === true;

// Checks one reference id with Kadima and records every approved payment made with it.
// Returns { paid, declined?, message?, amountCents?, ...applyPayment result }.
export async function syncKadimaPayment(creds, invoiceId, ref) {
  if (!isKadimaRef(ref)) return { paid: false, ignored: 'bad reference' };
  const invoice = await getDoc(`invoices/${invoiceId}`);
  const link = invoice?.kadimaLinks?.[ref];
  if (!invoice || invoice.farrierId !== creds.farrierId || !link) return { paid: false, ignored: 'unknown reference' };

  const found = await findKadimaPayments(creds, ref);
  if (!found) return { paid: false };
  // Only payments on this farrier's own terminal, with exactly our reference.
  const mine = found.filter(t => t.externalId === ref && Number(t.terminal?.id) === creds.terminalId);
  const ok = mine.filter(approved);
  if (!ok.length) {
    const declined = mine.find(t => t?.status?.status && t.status.status !== 'Approved');
    if (declined) {
      if (invoice.kadimaOpenRef === ref) await patchDoc(`invoices/${invoiceId}`, { kadimaOpenRef: '' });
      return { paid: false, declined: true, message: declined.status.reason || declined.status.status || '' };
    }
    return { paid: false };
  }

  // Normally one; if the same form was paid twice, the second is logged for review by applyPayment.
  let result = null;
  let totalCents = 0;
  for (const t of ok) {
    const amountCents = toCentsSafe(t.amount);
    if (!(amountCents > 0)) continue;
    totalCents += amountCents;
    if (amountCents !== link.chargeCents) console.warn('Kadima amount differs from the form:', invoiceId, ref, amountCents, link.chargeCents);
    const last4 = String(t.card?.number ?? '').replace(/\D/g, '').padStart(4, '0').slice(-4);
    const brand = brandFromBin(t.card?.bin);
    const keyed = link.method === 'card_keyed';
    const r = await applyPayment(invoiceId, {
      paymentId: `kadima_${t.id}`,
      method: keyed ? 'card_keyed' : 'card_link',
      amountCents,
      // What the form asked for → what it was for. Anything else (an edited link): let
      // applyPayment work out the credit for what was really charged.
      ...(amountCents === link.chargeCents ? { creditCents: link.creditCents } : {}),
      source: 'kadima',
      reference: `Kadima ${t.id}`,
      last4: t.card?.number ? last4 : '', brand: t.card?.number ? brand : '',
      paidVia: keyed ? 'kadima_keyed' : 'kadima_link',
      processorDetails: {
        processor: 'kadima',
        referenceId: ref,
        transactionId: String(t.id),
        terminalId: String(creds.terminalId),
        approvalCode: String(t.authCode || '').trim(),
        bin: String(t.card?.bin || ''),
      },
    });
    if (!r.duplicate) {
      await patchDoc(`invoices/${invoiceId}`, { kadimaTransactionId: String(t.id) });
      if (!r.alreadyPaid) await sendPaidSms(invoice, amountCents);
    }
    result = result || r;
  }
  if (invoice.kadimaOpenRef === ref) await patchDoc(`invoices/${invoiceId}`, { kadimaOpenRef: '' });
  if (!result) return { paid: false };
  return { paid: true, amountCents: totalCents, invoice, ...result };
}

// Asks Kadima about the open form and the most recent others, newest first.
// Returns the first sync result that was paid, or null.
export async function syncRecentKadima(creds, invoiceId, invoice, max = 3) {
  const recent = Object.entries(invoice.kadimaLinks || {})
    .sort((a, b) => (b[0] === invoice.kadimaOpenRef) - (a[0] === invoice.kadimaOpenRef) || new Date(b[1]?.createdAt) - new Date(a[1]?.createdAt))
    .slice(0, max).map(([r]) => r);
  for (const r of recent) {
    const result = await syncKadimaPayment(creds, invoiceId, r);
    if (result.paid) return result;
  }
  return null;
}

// ── Refunds ──
// POST /payment/{id}/refund: Kadima voids a payment that hasn't settled and returns one that has.
export async function refundKadimaPayment(creds, invoiceId, invoice, cents) {
  const paid = (Array.isArray(invoice.payments) ? invoice.payments : []).filter(p => String(p.paymentId || '').startsWith('kadima_'));
  const payment = paid[paid.length - 1];
  if (!payment) throw new PaymentError('No Kadima payment on this invoice.');
  const paidCents = Math.round((payment.amount || 0) * 100);
  const already = (Array.isArray(invoice.refunds) ? invoice.refunds : [])
    .filter(r => r.transactionId === payment.paymentId).reduce((s, r) => s + Math.round((r.amount || 0) * 100), 0);
  const left = paidCents - already;
  if (!Number.isInteger(cents) || cents <= 0) throw new PaymentError('Enter a refund amount.');
  if (cents > left) throw new PaymentError(`Refund can't be more than ${P.money(left)}.`);

  const txId = payment.paymentId.slice('kadima_'.length);
  if (!/^\d+$/.test(txId)) throw new PaymentError('Couldn’t find this payment in Kadima. Refund it in the Kadima dashboard instead.');
  const r = await kadimaFetch(creds, 'gateway', 'POST', `/payment/${txId}/refund`, {
    body: { terminal: { id: creds.terminalId }, amount: toAmount(cents) },
  });
  console.log('Kadima refund:', invoiceId, txId, r.status, JSON.stringify(r.data).slice(0, 500));
  if (!r.ok || r.data?.status?.status !== 'Approved') {
    const why = r.data?.status?.reason || errorText(r.data, r.status ? `HTTP ${r.status}` : 'no response');
    throw new PaymentError(`Kadima didn’t take the refund: ${why}. You can refund it in the Kadima dashboard instead.`, 400);
  }
  const kind = /void/i.test(String(r.data.type || '')) ? 'void' : 'refund';

  const fresh = await getDoc(`invoices/${invoiceId}`);
  const refunds = [...(Array.isArray(fresh.refunds) ? fresh.refunds : []), {
    amount: cents / 100, refundId: String(r.data.id || ''), transactionId: payment.paymentId,
    processor: 'kadima', kind, date: new Date().toISOString(),
  }];
  const refundedAmount = refunds.reduce((s, x) => s + (x.amount || 0), 0);
  const paidTotal = fresh.paidAmount || (fresh.payments || []).reduce((s, p) => s + (p.amount || 0), 0) || fresh.total || 0;
  const fully = refundedAmount >= paidTotal - 0.001;
  await patchDoc(`invoices/${invoiceId}`, {
    refunds, refundedAmount, updatedAt: new Date(),
    ...(fully ? { status: 'refunded', refundedAt: new Date() } : {}),
  });
  return { kind, amountCents: cents, refundId: String(r.data.id || '') };
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
