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
const REUSE_DAYS = 6;      // a form older than this isn't reused (Kadima forms don't expire)
const KEEP_LINKS = 10;     // forms remembered per invoice, so an older one can still be confirmed
const SECRET_FIELDS = ['kadimaToken', 'kadimaTerminalId', 'kadimaDbaId', 'kadimaMode', 'kadimaConnectedAt', 'kadimaWebhookSecret', 'kadimaWebhookLast'];

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

// Kadima forms can't be cancelled, so before the token is dropped, record anything already
// paid on any of the farrier's forms (afterwards such payments couldn't be confirmed here —
// they'd still be in the farrier's Kadima account).
export async function disconnectKadima(farrierId) {
  const creds = await getKadimaCreds(farrierId);
  let paid = 0;
  if (creds) {
    const withForms = (await queryIn('invoices', 'farrierId', [farrierId])).filter(i => Object.keys(i.kadimaLinks || {}).length);
    for (const inv of withForms) {
      try {
        const r = await syncKadimaInvoice(creds, inv.id);
        if (r.recorded) paid++;
        await patchDoc(`invoices/${inv.id}`, { kadimaOpenRef: '' });
      } catch (e) { console.warn('Kadima disconnect: check failed', inv.id, e.message); }
    }
  }
  await patchDoc(`farrierSecrets/${farrierId}`, {}, SECRET_FIELDS);
  return { paid };
}

// ── Payment forms ──
// A Kadima form stays payable for as long as someone has it open — Kadima has no way to
// cancel one. So an invoice gets ONE form per amount: the customer's pay link and a keyed
// card for the same amount share it, and a new form is only made when the amount changes
// (part payment, card price waived) or the old one is a week old. Every form ever made for
// the invoice stays on file (kadimaLinks) and is checked with Kadima on every sync, so a
// payment on an old tab is still found — and a second card payment on an invoice a Kadima
// card already paid is refunded straight back (see syncKadimaInvoice).

// Makes (or reuses) a Kadima hosted payment form for what's owed (card price unless waived).
// `card_keyed` is the same form shown on the farrier's own screen; `applyCents` pays off part of
// the balance. The card number goes straight to Kadima and never passes through FarriTech.
export async function createKadimaPage(creds, invoiceId, invoice, { method = 'card_link', applyCents = 0 } = {}) {
  // Record anything already paid on this invoice's forms first, then work from the fresh invoice.
  const synced = await syncKadimaInvoice(creds, invoiceId);
  const fresh = (await getDoc(`invoices/${invoiceId}`)) || invoice;
  // Callers may pass changes not saved yet (e.g. the card price being waived); keep those.
  const current = { ...fresh, ...pick(invoice, ['cardFeeWaived']) };
  if (current.status === 'paid') throw new PaymentError('Customer already paid by card.', 409);

  const balance = P.balanceCents(current);
  const cashCents = applyCents > 0 ? Math.min(applyCents, balance) : balance;
  if (cashCents <= 0) throw new PaymentError('Nothing is owed on this invoice.');
  const chargeCents = P.getChargeCents(current, method, cashCents);
  const paymentUrl = payUrlFor(invoiceId);

  // Reuse a recent form for exactly this amount that nobody has paid or tried yet.
  const reuse = Object.entries(current.kadimaLinks || {})
    .filter(([ref, l]) => l?.v === 2 && l.url && l.chargeCents === chargeCents && l.creditCents === cashCents
      && !synced.touchedRefs.has(ref) && Date.now() - new Date(l.createdAt).getTime() < REUSE_DAYS * 86400e3)
    .sort((a, b) => new Date(b[1].createdAt) - new Date(a[1].createdAt))[0];
  if (reuse) {
    const [ref, link] = reuse;
    await patchDoc(`invoices/${invoiceId}`, { kadimaOpenRef: ref, paymentUrl, paymentLinkUrl: paymentUrl, updatedAt: new Date() });
    return { url: link.url, ref, chargeCents, cashCents, paymentUrl, reused: true };
  }

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
      returnUrl: paymentUrl,
      // 'self': in the app's keyed-card frame it stays in the frame; opened by a customer it's
      // the whole window anyway — so one form serves both.
      returnUrlNavigation: 'self',
      sendReceipt: 'No',               // FarriTech texts its own "payment received"
    },
  });
  if (!r.ok || !r.data?.url) {
    console.error('Kadima hosted form failed:', invoiceId, r.status, JSON.stringify(r.data).slice(0, 500));
    throw new PaymentError(`Kadima couldn’t make the payment page: ${errorText(r.data, r.status ? `HTTP ${r.status}` : 'no response')}`, 400);
  }

  const links = Object.fromEntries(Object.entries(current.kadimaLinks || {})
    .sort((a, b) => new Date(b[1]?.createdAt) - new Date(a[1]?.createdAt)).slice(0, KEEP_LINKS - 1));
  links[ref] = { v: 2, url: r.data.url, chargeCents, creditCents: cashCents, method, createdAt: new Date() };
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

const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && k in o).map(k => [k, o[k]]));

// Stops offering the open form (it can't be cancelled at Kadima; any payment on it is still
// found by later syncs). If something was already paid, it's recorded and { paid: true } comes back.
export async function closeKadimaPages(creds, invoiceId, invoice) {
  if (!Object.keys(invoice.kadimaLinks || {}).length) return { paid: false };
  const synced = await syncKadimaInvoice(creds, invoiceId);
  if (invoice.kadimaOpenRef) await patchDoc(`invoices/${invoiceId}`, { kadimaOpenRef: '' });
  return { paid: !!synced.recorded, closed: true };
}

// ── Payment status ──
// Kadima's own record of payments made with any of these reference ids, or null if it
// couldn't be asked. One request: filter[externalId][in][]=… (checked in the sandbox).
export async function findKadimaPayments(creds, refs) {
  const list = (Array.isArray(refs) ? refs : [refs]).filter(isKadimaRef);
  if (!list.length) return [];
  const url = new URL(hosts(creds.mode).gateway + '/payments');
  list.forEach(ref => url.searchParams.append('filter[externalId][in][]', ref));
  url.searchParams.set('per-page', '50');
  const r = await kadimaFetch(creds, 'gateway', 'GET', '/payments' + url.search);
  if (!r.ok) {
    console.warn('Kadima payment lookup failed:', list.join(','), r.status, JSON.stringify(r.data).slice(0, 300));
    return null;
  }
  return Array.isArray(r.data?.items) ? r.data.items : [];
}

const approved = (t) => t?.status?.status === 'Approved' && t.captured === true;
// Only a definite decline counts as one. Right after the customer presses Pay, Kadima can
// briefly report the payment in an in-between state (not yet approved/captured) — treating
// that as a decline told a farrier "the card didn't go through" for a card that was charged
// a second later (417342, 2026-11-19). Anything that isn't clearly declined is still pending.
const DECLINE_RE = /^(declin|fail|error|reject)/i;
const declinedTx = (t) => !approved(t) && t?.captured !== true && DECLINE_RE.test(String(t?.status?.status || ''));

// Asks Kadima about every form this invoice has had and records each approved payment (oldest
// first) — exactly once, keyed by Kadima's payment id. A payment that lands on an invoice a
// Kadima card already paid is a double charge: it is refunded straight back through Kadima
// (a void if it hasn't settled) and noted on the invoice. One landing on an invoice paid some
// other way (cash, check…) is kept and flagged for the farrier to review, as applyPayment does.
//
// Returns { recorded, reversed, touchedRefs, byRef } where byRef[ref] = { paidCents, reversedCents,
// declined, message } for each of the invoice's forms that has any Kadima transaction.
export async function syncKadimaInvoice(creds, invoiceId) {
  const out = { recorded: 0, reversed: 0, touchedRefs: new Set(), byRef: {} };
  const invoice = await getDoc(`invoices/${invoiceId}`);
  if (!invoice || invoice.farrierId !== creds.farrierId) return out;
  const links = invoice.kadimaLinks || {};
  const refs = Object.keys(links).filter(isKadimaRef);
  if (!refs.length) return out;

  const found = await findKadimaPayments(creds, refs);
  if (!found) return out;
  // Only payments on this farrier's own terminal, with one of this invoice's references.
  const mine = found.filter(t => refs.includes(t.externalId) && Number(t.terminal?.id) === creds.terminalId);
  for (const t of mine) {
    out.touchedRefs.add(t.externalId);
    const s = (out.byRef[t.externalId] ||= { paidCents: 0, reversedCents: 0, declined: false, message: '' });
    if (declinedTx(t)) {
      s.declined = true;
      s.message = t.status.reason || t.status.status || '';
    }
  }

  for (const t of mine.filter(approved).sort((a, b) => Number(a.id) - Number(b.id))) {
    const link = links[t.externalId];
    const s = out.byRef[t.externalId];
    const amountCents = toCentsSafe(t.amount);
    if (!(amountCents > 0)) continue;
    if (amountCents !== link.chargeCents) console.warn('Kadima amount differs from the form:', invoiceId, t.externalId, amountCents, link.chargeCents);
    const before = await getDoc(`invoices/${invoiceId}`);
    const kadimaAlreadyPaid = before?.status === 'paid'
      && (before.payments || []).some(p => String(p.paymentId || '').startsWith('kadima_') && p.paymentId !== `kadima_${t.id}`);
    const last4 = String(t.card?.number ?? '').replace(/\D/g, '').padStart(4, '0').slice(-4);
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
      last4: t.card?.number ? last4 : '', brand: t.card?.number ? brandFromBin(t.card?.bin) : '',
      paidVia: keyed ? 'kadima_keyed' : 'kadima_link',
      processorDetails: {
        processor: 'kadima',
        referenceId: t.externalId,
        transactionId: String(t.id),
        terminalId: String(creds.terminalId),
        approvalCode: String(t.authCode || '').trim(),
        bin: String(t.card?.bin || ''),
      },
    });
    if (r.duplicate) {
      // Seen before: count it the way it was handled then. A double charge logged for review
      // earlier (before automatic refunds, or when Kadima refused the refund) is refunded now.
      const doc = await getDoc(`invoices/${invoiceId}/payments/kadima_${t.id}`);
      if (doc?.reversed) { s.reversedCents += amountCents; continue; }
      if (!doc?.unapplied) { s.paidCents += amountCents; continue; }
      if (kadimaAlreadyPaid && !t.refunded && await reverseDuplicate(creds, invoiceId, t, amountCents)) {
        s.reversedCents += amountCents; out.reversed++;
      }
      continue;
    }
    if (r.alreadyPaid) {
      if (kadimaAlreadyPaid && !t.refunded) {
        const reversal = await reverseDuplicate(creds, invoiceId, t, amountCents);
        if (reversal) { s.reversedCents += amountCents; out.reversed++; continue; }
      }
      continue; // kept for review (paymentNeedsReview set by applyPayment)
    }
    s.paidCents += amountCents;
    out.recorded++;
    await patchDoc(`invoices/${invoiceId}`, { kadimaTransactionId: String(t.id) });
    await sendPaidSms(invoice, amountCents);
  }
  if (out.recorded && invoice.kadimaOpenRef) {
    const after = await getDoc(`invoices/${invoiceId}`);
    if (after?.status === 'paid') await patchDoc(`invoices/${invoiceId}`, { kadimaOpenRef: '' });
  }
  return out;
}

// Refunds a double charge straight back through Kadima and notes it on the invoice and on the
// payment record. Returns the refund id, or '' if Kadima wouldn't take it (then the payment
// stays flagged for review).
async function reverseDuplicate(creds, invoiceId, t, amountCents) {
  const r = await kadimaFetch(creds, 'gateway', 'POST', `/payment/${t.id}/refund`, {
    body: { terminal: { id: creds.terminalId }, amount: toAmount(amountCents) },
  });
  console.warn('Kadima duplicate payment reversed:', invoiceId, t.id, r.status, JSON.stringify(r.data).slice(0, 300));
  if (!r.ok || r.data?.status?.status !== 'Approved') return '';
  const refundId = String(r.data.id || '');
  const kind = /void/i.test(String(r.data.type || '')) ? 'void' : 'refund';
  await patchDoc(`invoices/${invoiceId}/payments/kadima_${t.id}`, { reversed: true, reversedAt: new Date(), reversalId: refundId, reversalKind: kind });
  const fresh = await getDoc(`invoices/${invoiceId}`);
  const others = (fresh?.kadimaDuplicates || []).filter(d => d.transactionId !== String(t.id));
  // (paymentNeedsReview, set by applyPayment, is left as it is: the farrier still sees it, and
  // kadimaDuplicates says this one was already refunded.)
  await patchDoc(`invoices/${invoiceId}`, {
    kadimaDuplicates: [...others, { transactionId: String(t.id), amount: amountCents / 100, refundId, kind, date: new Date().toISOString() }],
    updatedAt: new Date(),
  });
  return refundId;
}

// What happened to one form, for the keyed-card check and the customer's return.
// { paid, amountCents, declined, message }
export async function syncKadimaPayment(creds, invoiceId, ref) {
  if (!isKadimaRef(ref)) return { paid: false, ignored: 'bad reference' };
  const invoice = await getDoc(`invoices/${invoiceId}`);
  if (!invoice || invoice.farrierId !== creds.farrierId || !invoice.kadimaLinks?.[ref]) return { paid: false, ignored: 'unknown reference' };
  const synced = await syncKadimaInvoice(creds, invoiceId);
  const s = synced.byRef[ref];
  if (s?.paidCents) return { paid: true, amountCents: s.paidCents };
  if (s?.reversedCents) {
    return { paid: false, declined: true, reversed: true, message: 'this invoice was already paid by card, so this second charge was refunded automatically' };
  }
  if (s?.declined) return { paid: false, declined: true, message: s.message };
  return { paid: false };
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

// ── Webhook: POST /api/kadima/webhook/{farrierId} (vercel.json → stripe-payment?kadimaWebhook=…) ──
// The farrier adds this URL in their Kadima dashboard (Developers → Webhooks, event "Payment
// Transaction Created"), so a payment on ANY of their forms — even a tab nobody returns from —
// is checked within seconds instead of the next time someone opens the invoice. That's what
// lets a double charge be refunded right away.
//
// A webhook is only a nudge. Kadima's signature covers <secret><id><module><action><date>, not
// the payment data, so nothing in the body is trusted: syncKadimaInvoice asks Kadima itself.
// With a signature saved in Settings, events without the matching Webhook-Signature are refused.
export function kadimaSignature(secret, evt) {
  return crypto.createHash('sha512').update(`${secret}${evt?.id ?? ''}${evt?.module ?? ''}${evt?.action ?? ''}${evt?.date ?? ''}`).digest('hex');
}

const RECENT_FORM_DAYS = 8;

export async function kadimaWebhook(req, res, rawBody, farrierId) {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(farrierId)) return res.status(400).json({ error: 'Bad farrier id' });
  let evt = {};
  try { evt = JSON.parse(rawBody.toString() || '{}'); } catch (e) { return res.status(400).json({ error: 'Not JSON' }); }
  try {
    const secrets = await getDoc(`farrierSecrets/${farrierId}`);
    const creds = await getKadimaCreds(farrierId, secrets);
    if (!creds) return res.status(404).json({ error: 'Not found' });
    const secret = String(secrets?.kadimaWebhookSecret || '');
    if (secret) {
      const got = String(req.headers?.['webhook-signature'] || '').trim();
      const hex = kadimaSignature(secret, evt);
      // Kadima documents a SHA-512 sum; accept it as hex (any case) or base64.
      const ok = got && (safeEqual(got.toLowerCase(), hex) || safeEqual(got, Buffer.from(hex, 'hex').toString('base64')));
      if (!ok) {
        await noteWebhook(farrierId, evt, 'bad signature');
        console.warn('Kadima webhook: bad signature for', farrierId, JSON.stringify({ id: evt?.id, module: evt?.module, action: evt?.action, date: evt?.date, header: got ? `${got.slice(0, 12)}… (${got.length} chars)` : 'missing' }));
        return res.status(401).json({ error: 'Bad signature' });
      }
    }
    // Only new payments matter here; acknowledge everything else so Kadima doesn't retry.
    if (evt.module !== 'transaction' || !['create', 'reccuring', 'recurring'].includes(evt.action)) {
      await noteWebhook(farrierId, evt, secret ? 'ok' : 'ok (no signature saved)');
      return res.status(200).json({ received: true, ignored: `${evt.module}/${evt.action}` });
    }

    const ref = String(evt.data?.externalId ?? evt.data?.transaction?.externalId ?? '');
    const invoices = (await queryIn('invoices', 'farrierId', [farrierId])).filter(inv => {
      const links = inv.kadimaLinks || {};
      if (isKadimaRef(ref)) return !!links[ref];
      // No usable reference in the event: check every invoice with a recent form.
      return Object.values(links).some(l => Date.now() - new Date(l?.createdAt).getTime() < RECENT_FORM_DAYS * 86400e3);
    });
    let recorded = 0, reversed = 0;
    for (const inv of invoices) {
      const r = await syncKadimaInvoice(creds, inv.id);
      recorded += r.recorded; reversed += r.reversed;
    }
    await noteWebhook(farrierId, evt, secret ? 'ok' : 'ok (no signature saved)', { recorded, reversed });
    console.log(`📥 Kadima webhook ${evt.id} ${evt.module}/${evt.action} for ${farrierId}:`, JSON.stringify({ ref, invoices: invoices.length, recorded, reversed }));
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('❌ Kadima webhook error:', farrierId, err);
    return res.status(500).json({ error: 'Webhook failed' });
  }
}

// The last event received, shown in Settings so the farrier can see the webhook works
// ("last notification 5:48 PM — OK" / "signature didn't match"). Never stores payment data.
async function noteWebhook(farrierId, evt, result, counts = {}) {
  try {
    await patchDoc(`farrierSecrets/${farrierId}`, {
      kadimaWebhookLast: {
        at: new Date().toISOString(), result,
        event: `${String(evt?.module || '').slice(0, 30)}/${String(evt?.action || '').slice(0, 40)}`,
        recorded: counts.recorded || 0, reversed: counts.reversed || 0,
      },
    });
  } catch (e) { console.warn('Kadima webhook: could not note receipt', e.message); }
}

// Settings → Kadima: save (or clear) the webhook's Signature from the Kadima dashboard.
export async function setKadimaWebhookSecret(farrierId, secret) {
  secret = String(secret || '').trim();
  if (secret && !/^[\x21-\x7e]{8,200}$/.test(secret)) throw new PaymentError('That doesn’t look like a Kadima webhook signature. Copy it again from the Add Webhook screen.');
  if (!(await getKadimaCreds(farrierId))) throw new PaymentError('Connect Kadima first.');
  if (secret) await patchDoc(`farrierSecrets/${farrierId}`, { kadimaWebhookSecret: secret });
  else await patchDoc(`farrierSecrets/${farrierId}`, {}, ['kadimaWebhookSecret']);
  return { webhookSigned: !!secret };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
