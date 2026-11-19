// The customer-facing pay link: https://app.farritech.com/pay/{invoiceId}
// (vercel.json rewrites /pay/:id to /api/stripe-payment?payPage=1&invoice=:id — it runs
// inside stripe-payment because the Hobby plan allows only 12 functions per deploy)
//
// Checkout Sessions expire after 24 hours, so customers never get one directly. This
// link sends them to the invoice's open session if it's still good for the right
// amount, otherwise makes a new one. Stripe sends them back here afterwards with
// ?session_id=…, and we record the payment right away (the webhook does the same,
// whichever comes first wins; both are idempotent).
//
// Farriers who connected iPOSpays get an iPOSpays payment page instead (see ipospays.js);
// iPOSpays sends the customer back here with ?ipos_ref=… and we check that payment.
// Farriers who connected Kadima get a Kadima hosted payment form (see kadima.js); Kadima sends
// the customer back with ?id=…&externalId={our ref}&status=… and we check that payment with Kadima.
import Stripe from 'stripe';
import '../../lib/pricing.js';
import { getDoc, getStripeSecretKey } from './firebase-rest.js';
import { createCheckoutSession, recordCheckoutSession, escapeHtml, PaymentError } from './invoice-payments.js';
import { getIposCreds, syncIposPayment, createIposPage, reusableIposPage } from './ipospays.js';
import { getKadimaCreds, isKadimaRef, syncKadimaPayment, syncKadimaInvoice, createKadimaPage } from './kadima.js';

const P = globalThis.FarriPricing;

function page(res, status, title, message, extra = '') {
  res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { --bg:#f8fafc; --card:#fff; --text:#1e293b; --muted:#64748b; --accent:#059669; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f172a; --card:#1e293b; --text:#e2e8f0; --muted:#94a3b8; } }
  body { margin:0; padding:16px; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif; }
  .card { max-width:440px; margin:12vh auto 0; background:var(--card); border-radius:12px; padding:32px 24px; text-align:center; box-shadow:0 4px 20px rgba(0,0,0,.08); }
  h1 { font-size:1.4rem; margin:0 0 .5rem; } p { color:var(--muted); line-height:1.5; }
  a.btn { display:inline-block; margin-top:1rem; background:var(--accent); color:#fff; padding:12px 28px; border-radius:8px; text-decoration:none; font-weight:700; }
  .foot { margin-top:2rem; font-size:.75rem; color:var(--muted); }
  .logo { display:block; margin:0 auto 1.25rem; width:240px; max-width:70%; height:auto; }
  .rcpt { margin-top:1.5rem; text-align:left; border-top:1px solid rgba(100,116,139,.25); padding-top:1rem; }
  .rh { display:flex; justify-content:space-between; align-items:flex-start; gap:.75rem; margin-bottom:.75rem; }
  .biz { font-weight:700; } .sub { font-size:.8rem; color:var(--muted); line-height:1.4; }
  .badge { border:2px solid; border-radius:6px; padding:2px 8px; font-weight:800; font-size:.75rem; letter-spacing:.05em; white-space:nowrap; }
  .rcpt table { width:100%; border-collapse:collapse; font-size:.9rem; }
  .rcpt td { padding:.45rem 0; border-bottom:1px solid rgba(100,116,139,.15); vertical-align:top; }
  .rcpt td.r { text-align:right; white-space:nowrap; padding-left:.75rem; }
  .rcpt tr.tot td { font-weight:700; }
</style></head><body><div class="card"><picture><source srcset="/public/pay-logo-dark.png" media="(prefers-color-scheme: dark)"><img class="logo" src="/public/pay-logo.png" alt="FarriTech" width="240" height="47"></picture><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${extra}<div class="foot">Powered by FarriTech</div></div></body></html>`);
}

// ── Receipt: what /pay/{id} shows once the invoice is paid (the link in the "payment received" text) ──
const fmtDate = (v, tz) => {
  const d = v ? new Date(v) : null;
  if (!d || isNaN(d)) return '';
  try { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz || 'America/New_York' }); }
  catch (e) { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
};
const dollars = (n) => P.money(Math.round((Number(n) || 0) * 100));

async function receiptHtml(invoiceId) {
  const inv = await getDoc(`invoices/${invoiceId}`).catch(() => null);
  if (!inv) return '';
  const farrier = await getDoc(`farriers/${inv.farrierId}`).catch(() => null);
  const tz = farrier?.timezone || farrier?.timeZone;
  const items = Array.isArray(inv.items) ? inv.items : [];
  const rows = items.map((item) => {
    let svc = String(item?.serviceNameSnapshot || item?.description || 'Service').trim();
    if (svc === 'Custom Service (enter manually)') svc = 'Custom Service';
    const horse = P.itemHorseLabel(item);
    const qty = P.itemQty(item);
    const unit = P.itemUnitPrice(item);
    const line = P.lineAmount(unit, qty);
    return `<tr><td>${escapeHtml(svc)}${horse ? `<div class="sub">${escapeHtml(horse)}</div>` : ''}${qty > 1 ? `<div class="sub">${horse.includes('×') ? `${escapeHtml(dollars(unit))} each` : `${qty} × ${escapeHtml(dollars(unit))}`}</div>` : ''}</td><td class="r">${escapeHtml(dollars(line))}</td></tr>`;
  }).join('');
  const payments = (Array.isArray(inv.payments) ? inv.payments : []).map(p =>
    `<tr><td>Paid ${escapeHtml(fmtDate(p.date, tz))}<div class="sub">${escapeHtml(p.memo || p.method || '')}</div></td><td class="r">${escapeHtml(dollars(p.amount))}</td></tr>`).join('');
  const refunds = (Array.isArray(inv.refunds) ? inv.refunds : []).map(r =>
    `<tr><td>Refunded ${escapeHtml(fmtDate(r.date, tz))}</td><td class="r">−${escapeHtml(dollars(r.amount))}</td></tr>`).join('');
  const status = inv.status === 'refunded' ? ['REFUNDED', '#b45309'] : inv.status === 'paid' ? ['PAID', '#059669'] : inv.status === 'partial' ? ['PARTIALLY PAID', '#b45309'] : null;
  const owed = Number(inv.balanceDue) > 0 && inv.status !== 'paid' && inv.status !== 'refunded'
    ? `<tr class="tot"><td>Balance due</td><td class="r">${escapeHtml(dollars(inv.balanceDue))}</td></tr>` : '';
  return `<div class="rcpt">
  <div class="rh"><div><div class="biz">${escapeHtml(farrier?.businessName || 'Your Farrier')}</div>
  <div class="sub">Invoice #${escapeHtml(inv.invoiceNumber || '')}${fmtDate(inv.date || inv.createdAt, tz) ? ` · ${escapeHtml(fmtDate(inv.date || inv.createdAt, tz))}` : ''}${inv.customerName ? `<br>${escapeHtml(inv.customerName)}` : ''}</div></div>
  ${status ? `<span class="badge" style="color:${status[1]};border-color:${status[1]}">${status[0]}</span>` : ''}</div>
  <table>${rows}<tr class="tot"><td>Total</td><td class="r">${escapeHtml(dollars(inv.total))}</td></tr>${payments}${refunds}${owed}</table>
</div>`;
}

// "Payment received" / "Invoice paid" with the receipt underneath.
async function paidPage(res, invoiceId, title, message) {
  return page(res, 200, title, message, await receiptHtml(invoiceId).catch(() => ''));
}

export async function payPage(req, res) {
  const invoiceId = String(req.query?.invoice || '');
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(invoiceId)) return page(res, 404, 'Invoice not found', 'This payment link is not valid. Please contact your farrier.');

  try {
    const invoice = await getDoc(`invoices/${invoiceId}`);
    if (!invoice) return page(res, 404, 'Invoice not found', 'This payment link is not valid. Please contact your farrier.');
    const number = invoice.invoiceNumber || '';
    const key = await getStripeSecretKey(invoice.farrierId);

    // Back from Stripe: a Checkout Session, or an old Stripe Payment Link (those redirected to
    // the customer portal; customer-portal.html now sends them here). Checked before iPOSpays,
    // so a farrier who has since switched to iPOSpays never offers a second payment page.
    // recordCheckoutSession confirms the session with Stripe and works out its invoice.
    const sessionId = String(req.query?.session_id || '');
    if (sessionId && key) {
      const stripe = new Stripe(key);
      const session = await stripe.checkout.sessions.retrieve(sessionId).catch(() => null);
      if (session?.payment_status === 'paid') {
        const result = await recordCheckoutSession(stripe, invoice.farrierId, session).catch(() => null);
        if (result?.invoiceId === invoiceId) {
          return paidPage(res, invoiceId, 'Payment received', `Thank you! Your payment of ${P.money(session.amount_total)} for Invoice #${number} has been received.`);
        }
      }
    }

    const ipos = await getIposCreds(invoice.farrierId);
    if (ipos) return await iposPayPage(req, res, invoiceId, invoice, ipos);
    const kadima = await getKadimaCreds(invoice.farrierId);
    if (kadima) return await kadimaPayPage(req, res, invoiceId, invoice, kadima);

    if (invoice.status === 'paid') return paidPage(res, invoiceId, 'Invoice paid', `Invoice #${number} has been paid. Thank you!`);
    if (invoice.status === 'cancelled') return page(res, 200, 'Invoice cancelled', `Invoice #${number} was cancelled. Please contact your farrier with any questions.`);
    if (!key) return page(res, 200, 'Online payment unavailable', 'Your farrier is not set up for online payments right now. Please contact them to pay.');

    const stripe = new Stripe(key);
    const expected = P.getChargeCents(invoice, 'card_link');
    if (expected <= 0) return page(res, 200, 'Nothing owed', `There's no balance due on Invoice #${number}.`);

    // Reuse the open session if it's still for the right amount.
    if (invoice.checkoutSessionId) {
      const current = await stripe.checkout.sessions.retrieve(invoice.checkoutSessionId).catch(() => null);
      if (current?.status === 'complete' && current.payment_status === 'paid') {
        await recordCheckoutSession(stripe, invoice.farrierId, current);
        return paidPage(res, invoiceId, 'Invoice paid', `Invoice #${number} has been paid. Thank you!`);
      }
      if (current?.status === 'open' && current.amount_total === expected && current.url && !req.query?.canceled) {
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(303, current.url);
      }
      if (req.query?.canceled) {
        return page(res, 200, 'Payment not completed', `Your payment for Invoice #${number} wasn't completed.`, `<a class="btn" href="/pay/${encodeURIComponent(invoiceId)}">Pay ${P.money(expected)}</a>`);
      }
    }

    const { session } = await createCheckoutSession(stripe, invoiceId, invoice);
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('pay link error:', invoiceId, err);
    return page(res, 500, 'Something went wrong', 'We couldn’t open the payment page. Please try again in a minute, or contact your farrier.');
  }
}

async function iposPayPage(req, res, invoiceId, invoice, creds) {
  const number = invoice.invoiceNumber || '';
  const retry = (cents) => `<a class="btn" href="/pay/${encodeURIComponent(invoiceId)}">Pay ${P.money(cents)}</a>`;

  // Back from iPOSpays
  // iPOSpays may tack its own "?…" onto our return URL, so keep only the leading reference id.
  const ref = (String(req.query?.ipos_ref || '').match(/^[A-Za-z0-9]{1,20}/) || [''])[0];
  if (ref) {
    const result = await syncIposPayment(creds, invoiceId, ref);
    if (result.paid) return paidPage(res, invoiceId, 'Payment received', `Thank you! Your payment of ${P.money(result.amountCents)} for Invoice #${number} has been received.`);
    const fresh = await getDoc(`invoices/${invoiceId}`);
    if (result.declined && fresh?.status !== 'paid') {
      return page(res, 200, 'Payment not completed', `Your card payment for Invoice #${number} didn't go through${result.message ? ` (${result.message})` : ''}. You can try again with another card.`, retry(P.getChargeCents(fresh, 'card_link')));
    }
    if (fresh) invoice = fresh;
    // Not confirmed yet: never send them straight back to a payment page they may have just
    // paid. They can check again (or pay, if it really didn't go through) from here.
    if (fresh?.status !== 'paid') {
      return page(res, 200, 'Confirming your payment', `We haven't heard back from the card processor about your payment for Invoice #${number} yet. Please don't pay again. Check back in a minute.`, `<a class="btn" href="/pay/${encodeURIComponent(invoiceId)}?ipos_ref=${ref}">Check again</a>`);
    }
  }

  // Before offering a page, ask iPOSpays about the recent ones: a customer may have paid
  // (or tried, which expires the page) without the return ever reaching us.
  if (!ref && invoice.status !== 'paid' && invoice.iposLinks) {
    const recent = Object.entries(invoice.iposLinks)
      .sort((a, b) => (b[0] === invoice.iposOpenRef) - (a[0] === invoice.iposOpenRef) || new Date(b[1]?.createdAt) - new Date(a[1]?.createdAt))
      .slice(0, 3).map(([r]) => r);
    for (const r of recent) {
      const result = await syncIposPayment(creds, invoiceId, r);
      if (result.paid) return paidPage(res, invoiceId, 'Payment received', `Thank you! Your payment of ${P.money(result.amountCents)} for Invoice #${number} has been received.`);
    }
    invoice = (await getDoc(`invoices/${invoiceId}`)) || invoice;
  }

  if (invoice.status === 'paid') return paidPage(res, invoiceId, 'Invoice paid', `Invoice #${number} has been paid. Thank you!`);
  if (invoice.status === 'cancelled') return page(res, 200, 'Invoice cancelled', `Invoice #${number} was cancelled. Please contact your farrier with any questions.`);
  const expected = P.getChargeCents(invoice, 'card_link');
  if (expected <= 0) return page(res, 200, "Nothing owed", `There's no balance due on Invoice #${number}.`);
  if (req.query?.canceled) return page(res, 200, 'Payment not completed', `Your payment for Invoice #${number} wasn't completed.`, retry(expected));

  res.setHeader('Cache-Control', 'no-store');
  const open = reusableIposPage(invoice, expected);
  if (open) return res.redirect(303, open);
  try {
    const { url } = await createIposPage(creds, invoiceId, invoice);
    return res.redirect(303, url);
  } catch (err) {
    if (err instanceof PaymentError && err.status === 409) return paidPage(res, invoiceId, 'Invoice paid', `Invoice #${number} has been paid. Thank you!`);
    throw err;
  }
}

// Kadima: the return parameters (status, amount, id) are unsigned, so they only decide which
// reference to look up — whether it was paid is always Kadima's own answer (syncKadimaPayment).
async function kadimaPayPage(req, res, invoiceId, invoice, creds) {
  const number = invoice.invoiceNumber || '';
  const retry = (cents) => `<a class="btn" href="/pay/${encodeURIComponent(invoiceId)}">Pay ${P.money(cents)}</a>`;
  const receivedPage = (cents) => paidPage(res, invoiceId, 'Payment received', `Thank you! Your payment of ${P.money(cents)} for Invoice #${number} has been received.`);

  // Back from Kadima
  const ref = String(req.query?.externalId || '');
  if (isKadimaRef(ref)) {
    const result = await syncKadimaPayment(creds, invoiceId, ref);
    if (result.paid) return receivedPage(result.amountCents);
    const fresh = (await getDoc(`invoices/${invoiceId}`)) || invoice;
    if (fresh.status === 'paid') return paidPage(res, invoiceId, 'Invoice paid', `Invoice #${number} has been paid. Thank you!`);
    if (result.declined) {
      return page(res, 200, 'Payment not completed', `Your card payment for Invoice #${number} didn't go through${result.message ? ` (${result.message})` : ''}. You can try again with another card.`, retry(P.getChargeCents(fresh, 'card_link')));
    }
    // Kadima says it was cancelled (the button on its form), and has no payment for it.
    if (/^cancel/i.test(String(req.query?.status || ''))) {
      return page(res, 200, 'Payment not completed', `Your payment for Invoice #${number} wasn't completed.`, retry(P.getChargeCents(fresh, 'card_link')));
    }
    // Not confirmed yet: never send them straight back to a form they may have just paid.
    return page(res, 200, 'Confirming your payment', `We haven't heard back from the card processor about your payment for Invoice #${number} yet. Please don't pay again. Check back in a minute.`, `<a class="btn" href="/pay/${encodeURIComponent(invoiceId)}?externalId=${ref}">Check again</a>`);
  }

  // Before offering a form, ask Kadima about every form this invoice has had: a customer may
  // have paid without the return ever reaching us (createKadimaPage checks again, too).
  if (invoice.status !== 'paid' && invoice.kadimaLinks) {
    const synced = await syncKadimaInvoice(creds, invoiceId);
    invoice = (await getDoc(`invoices/${invoiceId}`)) || invoice;
    if (synced.recorded && invoice.status === 'paid') return paidPage(res, invoiceId, 'Payment received', `Thank you! Your payment for Invoice #${number} has been received.`);
  }

  if (invoice.status === 'paid') return paidPage(res, invoiceId, 'Invoice paid', `Invoice #${number} has been paid. Thank you!`);
  if (invoice.status === 'cancelled') return page(res, 200, 'Invoice cancelled', `Invoice #${number} was cancelled. Please contact your farrier with any questions.`);
  const expected = P.getChargeCents(invoice, 'card_link');
  if (expected <= 0) return page(res, 200, 'Nothing owed', `There's no balance due on Invoice #${number}.`);
  if (req.query?.canceled) return page(res, 200, 'Payment not completed', `Your payment for Invoice #${number} wasn't completed.`, retry(expected));

  res.setHeader('Cache-Control', 'no-store');
  try {
    // Reuses the invoice's open form for this amount if there is one (never a second form).
    const { url } = await createKadimaPage(creds, invoiceId, invoice);
    return res.redirect(303, url);
  } catch (err) {
    if (err instanceof PaymentError && err.status === 409) return paidPage(res, invoiceId, 'Invoice paid', `Invoice #${number} has been paid. Thank you!`);
    throw err;
  }
}
