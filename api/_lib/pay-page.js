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
import Stripe from 'stripe';
import '../../lib/pricing.js';
import { getDoc, getStripeSecretKey } from './firebase-rest.js';
import { createCheckoutSession, recordCheckoutSession, escapeHtml, PaymentError } from './invoice-payments.js';
import { getIposCreds, syncIposPayment, createIposPage, reusableIposPage } from './ipospays.js';

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
</style></head><body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${extra}<div class="foot">Powered by FarriTech</div></div></body></html>`);
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
          return page(res, 200, 'Payment received', `Thank you! Your payment of ${P.money(session.amount_total)} for Invoice #${number} has been received.`);
        }
      }
    }

    const ipos = await getIposCreds(invoice.farrierId);
    if (ipos) return await iposPayPage(req, res, invoiceId, invoice, ipos);

    if (invoice.status === 'paid') return page(res, 200, 'Invoice paid', `Invoice #${number} has already been paid. Thank you!`);
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
        return page(res, 200, 'Invoice paid', `Invoice #${number} has already been paid. Thank you!`);
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
    if (result.paid) return page(res, 200, 'Payment received', `Thank you! Your payment of ${P.money(result.amountCents)} for Invoice #${number} has been received.`);
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
      if (result.paid) return page(res, 200, 'Payment received', `Thank you! Your payment of ${P.money(result.amountCents)} for Invoice #${number} has been received.`);
    }
    invoice = (await getDoc(`invoices/${invoiceId}`)) || invoice;
  }

  if (invoice.status === 'paid') return page(res, 200, 'Invoice paid', `Invoice #${number} has already been paid. Thank you!`);
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
    if (err instanceof PaymentError && err.status === 409) return page(res, 200, 'Invoice paid', `Invoice #${number} has already been paid. Thank you!`);
    throw err;
  }
}
