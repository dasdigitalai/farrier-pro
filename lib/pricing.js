// Dual pricing (card price vs cash price) — shared by the browser pages and the api/
// functions so the amount a farrier sees is the amount Stripe charges.
//
// Plain script on purpose: the pages load it with <script src="/lib/pricing.js">
// (window.FarriPricing) and the server does `import '../lib/pricing.js'` and reads
// globalThis.FarriPricing.
//
// The farrier's setting (farriers/{uid}.cardPricingEnabled, default on, and .cardPriceRate,
// default 0.03) is copied onto each invoice as invoice.cardPriceRate when the invoice is
// created, so changing the setting later never changes an existing invoice. Invoices from
// before dual pricing have no cardPriceRate and have no card price.
//
// All money math is integer cents. An invoice's balance is always tracked at the cash
// price; a card payment pays down round(charged / (1 + rate)) of it. That way a partial
// cash payment followed by a card payment only puts the card price on what's left.
(function (root) {
  const DEFAULT_CARD_PRICE_RATE = 0.03;
  const MAX_CARD_PRICE_RATE = 0.05;
  const CARD_METHODS = ['card_link', 'card_keyed', 'tap_to_pay', 'card_terminal'];
  const MANUAL_METHODS = {
    cash: 'Cash', check: 'Check', ach: 'ACH', zelle: 'Zelle', venmo: 'Venmo',
    card_terminal: 'External card', other: 'Other',
  };

  const isCardMethod = (method) => CARD_METHODS.includes(method);

  function validRate(r) {
    const n = Number(r);
    return Number.isFinite(n) && n >= 0 && n <= MAX_CARD_PRICE_RATE ? n : null;
  }

  // The rate to snapshot onto a new invoice from the farrier's settings (0 when off).
  function farrierCardPriceRate(farrier) {
    if (farrier && farrier.cardPricingEnabled === false) return 0;
    return validRate(farrier?.cardPriceRate) ?? DEFAULT_CARD_PRICE_RATE;
  }

  // The rate this invoice was created with (0 for invoices from before dual pricing).
  const invoiceRate = (invoice) => validRate(invoice?.cardPriceRate) ?? 0;

  const toCents = (dollars) => Math.round((Number(dollars) || 0) * 100);
  const cardCents = (cashCents, rate) => Math.round(cashCents * (1 + (rate || 0)));

  // Cash-price amount already paid down. Payments recorded before dual pricing have no
  // creditAmount — they paid down exactly what they collected.
  function creditedCents(invoice) {
    if (!invoice) return 0;
    const payments = Array.isArray(invoice.payments) ? invoice.payments : [];
    if (payments.length) return payments.reduce((s, p) => s + toCents(p.creditAmount ?? p.amount), 0);
    return toCents(invoice.paidAmount);
  }

  // Remaining balance at the cash price.
  function balanceCents(invoice) {
    if (!invoice || invoice.status === 'paid' || invoice.status === 'cancelled') return 0;
    return Math.max(0, toCents(invoice.total) - creditedCents(invoice));
  }

  // What to charge with this method. Card methods get the card price unless the farrier
  // waived it on this invoice; everything else gets the cash price. `cashCents` defaults to
  // the remaining balance (the whole total when nothing has been paid yet).
  function getChargeCents(invoice, method, cashCents = balanceCents(invoice)) {
    if (isCardMethod(method) && !invoice?.cardFeeWaived) return cardCents(cashCents, invoiceRate(invoice));
    return cashCents;
  }

  // How much of the cash balance a payment pays down.
  function creditForPayment(invoice, method, chargedCents) {
    const rate = invoiceRate(invoice);
    if (!isCardMethod(method) || invoice?.cardFeeWaived || !rate) return chargedCents;
    const balance = balanceCents(invoice);
    if (chargedCents >= cardCents(balance, rate)) return balance;
    return Math.round(chargedCents / (1 + rate));
  }

  const money = (cents) => '$' + ((Number(cents) || 0) / 100).toFixed(2);

  // ── Invoice line items ──
  // A line is { description, amount, qty, unitPrice, horseId, horseName, note, ... }.
  // `amount` is always the line total (unitPrice x qty), so anything that just adds up
  // amounts, like the invoice total, reports and exports, stays right. `qty` is how many
  // horses the price covers (1 when unset, as on older invoices). A line for horses the
  // farrier doesn't know individually uses horseName MULTIPLE_HORSES with no horseId, and
  // `note` says what they are ("polo string, fronts only").
  const MULTIPLE_HORSES = 'Multiple horses';

  function itemQty(item) {
    const n = Math.floor(Number(item?.qty));
    return n >= 1 ? n : 1;
  }

  // Per-horse price: the saved unitPrice, or worked back from the line total on older lines.
  function itemUnitPrice(item) {
    const saved = item?.unitPrice;
    if (saved !== undefined && saved !== null && saved !== '' && Number.isFinite(Number(saved))) return Number(saved);
    return (Number(item?.amount) || 0) / itemQty(item);
  }

  // Line total for a per-horse price and a quantity, worked in cents so it never drifts.
  function lineAmount(unitPrice, qty) {
    const n = Math.floor(Number(qty));
    return Math.round((Number(unitPrice) || 0) * 100) * (n >= 1 ? n : 1) / 100;
  }

  // "Multiple horses × 10 — polo string, fronts only"; '' for a plain line with no horse.
  function itemHorseLabel(item) {
    const name = String(item?.horseName || '').trim();
    const qty = itemQty(item);
    const note = String(item?.note || '').trim();
    const head = name + (qty > 1 ? `${name ? ' ' : ''}× ${qty}` : '');
    return [head, note].filter(Boolean).join(' — ');
  }

  // { cash, card } in cents for what's still owed; card is null when there's no separate
  // card price (no rate on the invoice, waived, or nothing owed).
  function dualPrices(invoice) {
    const cash = balanceCents(invoice);
    const rate = invoiceRate(invoice);
    const card = rate > 0 && !invoice?.cardFeeWaived && cash > 0 ? cardCents(cash, rate) : null;
    return { cash, card };
  }

  // "Card price $154.50 / Cash or check $150.00", or just "$150.00".
  function dualPriceText(invoice) {
    const { cash, card } = dualPrices(invoice);
    return card === null ? money(cash) : `Card price ${money(card)} / Cash or check ${money(cash)}`;
  }

  // Line added to texts, emails and the invoice PDF wherever there's a pay link, when the
  // farrier also takes Zelle / Venmo (farriers/{uid}.zelleVenmoNote, default off), naming
  // their Zelle phone or email (farriers/{uid}.zelleContact) and Venmo username
  // (farriers/{uid}.venmoHandle) when set. Those are paid in the customer's own app and
  // recorded by the farrier with Record Payment.
  // Both are cut down to phone/email/username characters so they're safe to drop into HTML.
  const zelleContact = (farrier) => String(farrier?.zelleContact || '').replace(/[^\w@.+\-() ]/g, '').trim().slice(0, 80);
  const venmoHandle = (farrier) => String(farrier?.venmoHandle || '').replace(/[^\w-]/g, '').slice(0, 40);
  function altPayNote(farrier) {
    if (!farrier?.zelleVenmoNote) return '';
    const zelle = zelleContact(farrier), venmo = venmoHandle(farrier);
    const where = [zelle && `Zelle: ${zelle}`, venmo && `Venmo: @${venmo}`].filter(Boolean).join(', ');
    return where
      ? `Prefer Zelle or Venmo? Feel free to pay through your own app instead (${where}).`
      : 'Prefer Zelle or Venmo? Feel free to pay through your Zelle or Venmo app instead.';
  }

  // Venmo link that opens the farrier's profile with this invoice's cash-price balance and
  // number filled in ('' when the note is off, there's no handle, or nothing is owed).
  // Zelle has no equivalent — it lives inside each bank's app — so it's only named.
  function venmoPayUrl(farrier, invoice) {
    const handle = farrier?.zelleVenmoNote ? venmoHandle(farrier) : '';
    const cents = balanceCents(invoice);
    if (!handle || cents <= 0) return '';
    const note = encodeURIComponent(`Invoice #${invoice?.invoiceNumber || ''}`.trim());
    return `https://venmo.com/${handle}?txn=pay&amount=${(cents / 100).toFixed(2)}&note=${note}`;
  }

  // The note plus Venmo link for a text message, with a leading space ('' when off).
  function altPaySms(farrier, invoice) {
    const note = altPayNote(farrier);
    if (!note) return '';
    const venmo = venmoPayUrl(farrier, invoice);
    return ` ${note}${venmo ? ` Pay with Venmo: ${venmo}` : ''}`;
  }

  // The note plus a "Pay with Venmo" button for an email ('' when off). Everything in it is
  // already cut down to safe characters (see zelleContact / venmoHandle).
  function altPayHtml(farrier, invoice) {
    const note = altPayNote(farrier);
    if (!note) return '';
    const venmo = venmoPayUrl(farrier, invoice);
    return `<p style="text-align:center;color:#4b5563;font-size:14px;margin-top:16px;">${note}</p>`
      + (venmo ? `<p style="text-align:center;margin:12px 0;"><a href="${venmo}" style="background:#008CFF;color:#fff;padding:10px 28px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;">Pay ${money(balanceCents(invoice))} with Venmo</a></p>` : '');
  }

  root.FarriPricing = {
    DEFAULT_CARD_PRICE_RATE, MAX_CARD_PRICE_RATE, CARD_METHODS, MANUAL_METHODS,
    isCardMethod, farrierCardPriceRate, invoiceRate, toCents, cardCents, creditedCents, balanceCents,
    getChargeCents, creditForPayment, money, MULTIPLE_HORSES, itemQty, itemUnitPrice, lineAmount, itemHorseLabel, dualPrices, dualPriceText, zelleContact, venmoHandle, altPayNote, venmoPayUrl, altPaySms, altPayHtml,
  };
})(typeof window !== 'undefined' ? window : globalThis);
