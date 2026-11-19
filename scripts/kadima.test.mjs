// Tests for the Kadima card processor (api/_lib/kadima.js + the Kadima branch of the pay page).
//   node --test --experimental-test-module-mocks scripts/kadima.test.mjs
// No network and no Firestore: firebase-rest.js is replaced by an in-memory store, and every
// fetch goes to a fake Kadima. Any other host fails the test, so nothing can reach live data.
import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The code under test logs (e.g. "duplicate payment reversed"). Printing from inside a test file
// can corrupt node:test's own message stream ("Unable to deserialize cloned data"), so keep quiet.
for (const k of ['log', 'warn', 'error', 'info']) console[k] = () => {};

// ── In-memory Firestore ──
const store = new Map();
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const get = (path) => clone(store.get(path)) ?? null;
const patch = (path, fields = {}, del = []) => {
  const doc = { ...(store.get(path) || {}), ...clone(fields) };
  for (const f of del) delete doc[f];
  store.set(path, doc);
};
mock.module('../api/_lib/firebase-rest.js', {
  namedExports: {
    getDoc: async (p) => get(p),
    patchDoc: async (p, f, d) => patch(p, f, d),
    queryIn: async (coll, field, values) => [...store.entries()]
      .filter(([k, v]) => k.split('/').length === 2 && k.startsWith(`${coll}/`) && values.includes(v[field]))
      .map(([k, v]) => ({ id: k.split('/')[1], ...clone(v) })),
    runTransaction: async (fn) => {
      const writes = [];
      const result = await fn({
        get: async (p) => get(p),
        patch: (p, f) => writes.push(() => patch(p, f)),
        create: (p, f) => writes.push(() => { if (store.has(p)) throw new Error(`exists ${p}`); store.set(p, clone(f)); }),
      });
      writes.forEach(w => w());
      return result;
    },
    serverAuth: async () => ({ idToken: 'test', uid: 'server' }),
    getStripeSecretKey: async () => null,
  },
});

// ── Fake Kadima (and a tripwire for every other host) ──
const kadima = { payments: [], forms: [], refunds: [], requests: [], texts: [], tokenOk: true, nextId: 500000 };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const body = init.body ? JSON.parse(init.body) : undefined;
  kadima.requests.push({ method: init.method || 'GET', host: url.host, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: init.headers?.Authorization });
  // Customer texts go to FarriTech's own /api/send-sms: captured here, never sent.
  if (url.host === 'app.farritech.com' && url.pathname === '/api/send-sms') {
    kadima.texts.push(body);
    return json(200, { success: true });
  }
  if (!['sandbox-gateway.kadimadashboard.com', 'sandbox.kadimadashboard.com'].includes(url.host)) {
    throw new Error(`test tried to reach ${url.host}`);
  }
  if (!kadima.tokenOk) return json(401, { name: 'Unauthorized', message: 'Your request was made with invalid credentials.', status: 401 });
  if (url.pathname === '/payments') {
    const many = url.searchParams.getAll('filter[externalId][in][]');
    const one = url.searchParams.get('filter[externalId][eq]');
    const items = many.length ? kadima.payments.filter(p => many.includes(p.externalId))
      : one ? kadima.payments.filter(p => p.externalId === one) : kadima.payments.slice(0, 1);
    return json(200, { items, _meta: { totalCount: items.length } });
  }
  if (url.pathname === '/api/gateway/hosted-form' && init.method === 'POST') {
    kadima.forms.push(body);
    return json(200, { code: '<div></div>', url: `https://sandbox.kadimadashboard.com/gateway/public/form?data=x&externalId=${body.externalId}&amount=${body.amount}` });
  }
  const refund = url.pathname.match(/^\/payment\/(\d+)\/refund$/);
  if (refund && init.method === 'POST') {
    kadima.refunds.push({ id: refund[1], ...body });
    const orig = kadima.payments.find(p => String(p.id) === refund[1]);
    if (orig) orig.refunded = true;
    return json(200, { id: kadima.nextId++, type: 'Return', amount: String(body.amount), parent: { id: Number(refund[1]) }, status: { status: 'Approved', reason: null } });
  }
  return json(404, { name: 'Not Found', message: 'Page not found.' });
};

const K = await import('../api/_lib/kadima.js');
const { payPage } = await import('../api/_lib/pay-page.js');

const FARRIER = 'farrier1';
const CREDS = { farrierId: FARRIER, token: 'tok', terminalId: 865, dbaId: 980, mode: 'sandbox' };
const secrets = { kadimaToken: 'tok', kadimaTerminalId: 865, kadimaDbaId: 980, kadimaMode: 'sandbox' };

function newInvoice(id, extra = {}) {
  store.set(`invoices/${id}`, { farrierId: FARRIER, invoiceNumber: '1001', total: 100, status: 'outstanding', ...extra });
  return get(`invoices/${id}`);
}
// What Kadima's gateway returns for a hosted-form payment.
function kadimaPayment(ref, { amount, terminal = 865, status = 'Approved', captured = true, reason = null } = {}) {
  const p = { id: kadima.nextId++, amount: amount.toFixed(2), type: 'Auth', authCode: 'TAS821', externalId: ref, terminal: { id: terminal },
    card: { bin: 411111, number: 1111 }, captured, refunded: false, status: { status, reason } };
  kadima.payments.push(p);
  return p;
}
function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: '', location: '' };
  res.status = (c) => { res.statusCode = c; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; return res; };
  res.end = (b) => { res.body = b; return res; };
  res.redirect = (c, url) => { res.statusCode = c; res.location = url; return res; };
  return res;
}

beforeEach(() => {
  store.clear();
  Object.assign(kadima, { payments: [], forms: [], refunds: [], requests: [], texts: [], tokenOk: true });
  store.set(`farrierSecrets/${FARRIER}`, { ...secrets });
});

// ── Connect ──
test('connect checks the token on the gateway, makes a test form, and saves the ids as numbers', async () => {
  store.delete(`farrierSecrets/${FARRIER}`);
  const r = await K.connectKadima(FARRIER, { token: ' tok ', terminalId: '865', dbaId: '#980', mode: 'sandbox' });
  assert.deepEqual(r, { mode: 'sandbox', terminalId: 865, dbaId: 980 });
  const s = get(`farrierSecrets/${FARRIER}`);
  assert.equal(s.kadimaToken, 'tok');
  assert.equal(s.kadimaTerminalId, 865);
  assert.equal(s.kadimaDbaId, 980);
  assert.equal(kadima.requests[0].path, '/payments');
  assert.equal(kadima.requests[0].auth, 'Bearer tok');
  assert.deepEqual(kadima.forms[0].terminal, { id: 865 });
});

test('connect refuses bad input and a token Kadima rejects, saving nothing', async () => {
  store.delete(`farrierSecrets/${FARRIER}`);
  await assert.rejects(K.connectKadima(FARRIER, { token: '', terminalId: '865', dbaId: '980' }), /API token/);
  await assert.rejects(K.connectKadima(FARRIER, { token: 'tok', terminalId: '7000x', dbaId: '980' }), /Terminal ID/);
  kadima.tokenOk = false;
  await assert.rejects(K.connectKadima(FARRIER, { token: 'bad', terminalId: '865', dbaId: '980' }), /didn’t accept that API token/);
  assert.equal(get(`farrierSecrets/${FARRIER}`), null);
});

test('disconnect drops only the Kadima secrets', async () => {
  patch(`farrierSecrets/${FARRIER}`, { managerPasswordHash: 'h' });
  await K.disconnectKadima(FARRIER);
  assert.deepEqual(get(`farrierSecrets/${FARRIER}`), { managerPasswordHash: 'h' });
  assert.equal(await K.getKadimaCreds(FARRIER), null);
});

// ── Forms ──
test('a payment form asks for the card price, uses a fresh reference, and returns to /pay without a query', async () => {
  const inv = newInvoice('inv001', { cardPriceRate: 0.03 });
  const { ref, chargeCents, cashCents } = await K.createKadimaPage(CREDS, 'inv001', inv);
  assert.ok(K.isKadimaRef(ref));
  assert.equal(cashCents, 10000);
  assert.equal(chargeCents, 10300);
  const form = kadima.forms[0];
  assert.equal(form.amount, 103);
  assert.equal(form.externalId, ref);
  assert.deepEqual([form.dba, form.terminal], [{ id: 980 }, { id: 865 }]);
  assert.match(form.returnUrl, /\/pay\/inv001$/);
  assert.equal(form.returnUrlNavigation, 'self'); // stays in the app frame for keyed cards; whole window for customers
  const saved = get('invoices/inv001');
  assert.equal(saved.kadimaOpenRef, ref);
  assert.equal(saved.kadimaLinks[ref].chargeCents, 10300);
  assert.equal(saved.kadimaLinks[ref].creditCents, 10000);
});

test('pay link and keyed card for the same amount share ONE form; a new amount gets a new one', async () => {
  const inv = newInvoice('inv002', { cardPriceRate: 0.03 });
  const link = await K.createKadimaPage(CREDS, 'inv002', inv);
  const keyed = await K.createKadimaPage(CREDS, 'inv002', get('invoices/inv002'), { method: 'card_keyed' });
  assert.equal(keyed.ref, link.ref);
  assert.equal(keyed.reused, true);
  assert.equal(kadima.forms.length, 1);
  const part = await K.createKadimaPage(CREDS, 'inv002', get('invoices/inv002'), { method: 'card_keyed', applyCents: 4000 });
  assert.notEqual(part.ref, link.ref);
  assert.equal(part.chargeCents, 4120);
  assert.equal(kadima.forms.length, 2);
});

// ── Confirming payments ──
test('nothing is recorded until Kadima itself reports an approved, captured payment', async () => {
  const inv = newInvoice('inv003');
  const { ref } = await K.createKadimaPage(CREDS, 'inv003', inv);
  assert.equal((await K.syncKadimaPayment(CREDS, 'inv003', ref)).paid, false);
  kadimaPayment(ref, { amount: 100, captured: false }); // auth only
  assert.equal((await K.syncKadimaPayment(CREDS, 'inv003', ref)).paid, false);
  kadimaPayment(ref, { amount: 100, terminal: 999 });   // someone else's terminal
  assert.equal((await K.syncKadimaPayment(CREDS, 'inv003', ref)).paid, false);
  assert.equal(get('invoices/inv003').status, 'outstanding');
});

test('an approved payment marks the invoice paid once, with card details, even if checked twice', async () => {
  const inv = newInvoice('inv004', { cardPriceRate: 0.03 });
  const { ref } = await K.createKadimaPage(CREDS, 'inv004', inv);
  const p = kadimaPayment(ref, { amount: 103 });
  const first = await K.syncKadimaPayment(CREDS, 'inv004', ref);
  assert.equal(first.paid, true);
  assert.equal(first.amountCents, 10300);
  const second = await K.syncKadimaPayment(CREDS, 'inv004', ref);
  assert.deepEqual([second.paid, second.amountCents], [true, 10300]); // same answer, nothing recorded twice
  const saved = get('invoices/inv004');
  assert.equal(saved.status, 'paid');
  assert.equal(saved.payments.length, 1);
  assert.equal(saved.payments[0].creditAmount, 100);
  assert.equal(saved.payments[0].memo, 'Visa ending 1111');
  assert.equal(saved.payments[0].approvalCode, 'TAS821');
  assert.equal(saved.kadimaTransactionId, String(p.id));
  assert.equal(saved.kadimaOpenRef, '');
  const doc = get(`invoices/inv004/payments/kadima_${p.id}`);
  assert.equal(doc.source, 'kadima');
  assert.equal(doc.processorDetails.terminalId, '865');
});

test('an edited link that charged less only credits what was really paid', async () => {
  const inv = newInvoice('inv005');
  const { ref } = await K.createKadimaPage(CREDS, 'inv005', inv);
  kadimaPayment(ref, { amount: 0.01 }); // customer changed amount=100 to amount=0.01 in the URL
  await K.syncKadimaPayment(CREDS, 'inv005', ref);
  const saved = get('invoices/inv005');
  assert.equal(saved.status, 'partial');
  assert.equal(saved.payments[0].amount, 0.01);
  assert.equal(saved.balanceDue, 99.99);
});

test('a decline is reported and the form stops being offered', async () => {
  const inv = newInvoice('inv006');
  const { ref } = await K.createKadimaPage(CREDS, 'inv006', inv);
  kadimaPayment(ref, { amount: 100, status: 'Decline', captured: false, reason: 'AVS Zip Mismatch' });
  const r = await K.syncKadimaPayment(CREDS, 'inv006', ref);
  assert.deepEqual([r.paid, r.declined, r.message], [false, true, 'AVS Zip Mismatch']);
  // A declined form is never offered again: the retry gets a fresh one.
  const retry = await K.createKadimaPage(CREDS, 'inv006', get('invoices/inv006'));
  assert.notEqual(retry.ref, ref);
  assert.equal(kadima.forms.length, 2);
});

test('a Kadima payment that lands on an already-paid invoice is kept for review, not lost', async () => {
  const inv = newInvoice('inv007');
  const { ref } = await K.createKadimaPage(CREDS, 'inv007', inv);
  patch('invoices/inv007', { status: 'paid' }); // farrier recorded cash meanwhile
  const p = kadimaPayment(ref, { amount: 100 });
  const r = await K.syncKadimaPayment(CREDS, 'inv007', ref);
  assert.equal(r.paid, false);
  assert.equal(kadima.refunds.length, 0); // paid some other way: the farrier decides
  assert.equal(get('invoices/inv007').paymentNeedsReview, true);
  assert.equal(get(`invoices/inv007/payments/kadima_${p.id}`).unapplied, true);
});

test('unknown or foreign references are ignored', async () => {
  newInvoice('inv008');
  assert.equal((await K.syncKadimaPayment(CREDS, 'inv008', 'FTnotOursnotOursnotO')).ignored, 'unknown reference');
  assert.equal((await K.syncKadimaPayment(CREDS, 'inv008', 'drop table')).ignored, 'bad reference');
  assert.equal((await K.syncKadimaPayment({ ...CREDS, farrierId: 'someoneElse' }, 'inv008', K.newKadimaRef())).paid, false);
});

// ── Refunds ──
test('refunds go to Kadima on the farrier terminal, are recorded, and are capped at what was paid', async () => {
  const inv = newInvoice('inv009');
  const { ref } = await K.createKadimaPage(CREDS, 'inv009', inv);
  const p = kadimaPayment(ref, { amount: 100 });
  await K.syncKadimaPayment(CREDS, 'inv009', ref);
  await assert.rejects(K.refundKadimaPayment(CREDS, 'inv009', get('invoices/inv009'), 10001), /can't be more than/);
  const partial = await K.refundKadimaPayment(CREDS, 'inv009', get('invoices/inv009'), 2500);
  assert.equal(partial.kind, 'refund');
  assert.deepEqual(kadima.refunds[0], { id: String(p.id), terminal: { id: 865 }, amount: 25 });
  assert.equal(get('invoices/inv009').status, 'paid');
  await K.refundKadimaPayment(CREDS, 'inv009', get('invoices/inv009'), 7500);
  const saved = get('invoices/inv009');
  assert.equal(saved.status, 'refunded');
  assert.equal(saved.refundedAmount, 100);
  await assert.rejects(K.refundKadimaPayment(CREDS, 'inv009', saved, 1), /can't be more than/);
});

// ── Customer pay page ──
test('pay page sends the customer to a Kadima form for the balance', async () => {
  newInvoice('inv010');
  const res = fakeRes();
  await payPage({ query: { invoice: 'inv010' } }, res);
  assert.equal(res.statusCode, 303);
  assert.match(res.location, /^https:\/\/sandbox\.kadimadashboard\.com\/gateway\/public\/form/);
  assert.equal(kadima.forms[0].amount, 100);
});

test('a forged "Approved" return does not mark anything paid', async () => {
  const inv = newInvoice('inv011');
  const { ref } = await K.createKadimaPage(CREDS, 'inv011', inv);
  const res = fakeRes();
  await payPage({ query: { invoice: 'inv011', id: '1', externalId: ref, status: 'Approved', amount: '100' } }, res);
  assert.match(res.body, /Confirming your payment/);
  assert.equal(get('invoices/inv011').status, 'outstanding');
});

test('a genuine return shows the receipt, and a cancelled one offers to try again', async () => {
  const inv = newInvoice('inv012');
  const { ref } = await K.createKadimaPage(CREDS, 'inv012', inv);
  let res = fakeRes();
  await payPage({ query: { invoice: 'inv012', externalId: ref, status: 'Cancelled' } }, res);
  assert.match(res.body, /Payment not completed/);
  kadimaPayment(ref, { amount: 100 });
  res = fakeRes();
  await payPage({ query: { invoice: 'inv012', externalId: ref, status: 'Approved' } }, res);
  assert.match(res.body, /Payment received/);
  assert.equal(get('invoices/inv012').status, 'paid');
});

test('a payment whose return never arrived is found before a second form is offered', async () => {
  const inv = newInvoice('inv013');
  const { ref } = await K.createKadimaPage(CREDS, 'inv013', inv);
  kadimaPayment(ref, { amount: 100 });
  const res = fakeRes();
  await payPage({ query: { invoice: 'inv013' } }, res);
  assert.match(res.body, /Payment received/);
  assert.equal(kadima.forms.length, 1);
});

test('no request ever left for a host other than the Kadima sandbox (or the captured text endpoint)', () => {
  // (the fetch stub throws for any other host; this documents it)
  assert.ok(kadima.requests.every(r => r.host.endsWith('kadimadashboard.com') || r.path === '/api/send-sms'));
});

// ── Double charges (what happened in the sandbox on 2026-11-17: two forms, both paid) ──
test('two forms both paid: the first pays the invoice, the second is refunded automatically', async () => {
  const inv = newInvoice('inv020', { cardPriceRate: 0.03 });
  const a = await K.createKadimaPage(CREDS, 'inv020', inv);
  // Card price waived → a new amount → a second form, while the first is still open in a tab.
  const b = await K.createKadimaPage(CREDS, 'inv020', { ...get('invoices/inv020'), cardFeeWaived: true });
  patch('invoices/inv020', { cardFeeWaived: true });
  assert.notEqual(a.ref, b.ref);
  const first = kadimaPayment(a.ref, { amount: 103 });   // customer pays the old tab…
  const second = kadimaPayment(b.ref, { amount: 100 });  // …and the new one
  const r = await K.syncKadimaPayment(CREDS, 'inv020', b.ref);
  assert.equal(r.paid, false);
  assert.equal(r.reversed, true);
  const saved = get('invoices/inv020');
  assert.equal(saved.status, 'paid');
  assert.equal(saved.payments.length, 1);
  assert.equal(saved.payments[0].paymentId, `kadima_${first.id}`);
  assert.equal(kadima.refunds.length, 1);
  assert.deepEqual(kadima.refunds[0], { id: String(second.id), terminal: { id: 865 }, amount: 100 });
  assert.equal(saved.kadimaDuplicates[0].transactionId, String(second.id));
  assert.equal(get(`invoices/inv020/payments/kadima_${second.id}`).reversed, true);
  // Checking again changes nothing and refunds nothing more.
  await K.syncKadimaInvoice(CREDS, 'inv020');
  assert.equal(kadima.refunds.length, 1);
  assert.equal(get('invoices/inv020').payments.length, 1);
});

test('the same form paid twice: the second charge is refunded automatically', async () => {
  const inv = newInvoice('inv021');
  const { ref } = await K.createKadimaPage(CREDS, 'inv021', inv);
  kadimaPayment(ref, { amount: 100 });
  const dup = kadimaPayment(ref, { amount: 100 });
  const r = await K.syncKadimaPayment(CREDS, 'inv021', ref);
  assert.equal(r.paid, true);
  assert.equal(r.amountCents, 10000);
  assert.equal(kadima.refunds[0].id, String(dup.id));
  assert.equal(get('invoices/inv021').payments.length, 1);
});

test('a payment on an OLD form is still found after a newer form was made', async () => {
  const inv = newInvoice('inv022', { cardPriceRate: 0.03 });
  const a = await K.createKadimaPage(CREDS, 'inv022', inv);
  await K.createKadimaPage(CREDS, 'inv022', get('invoices/inv022'), { method: 'card_keyed', applyCents: 5000 });
  kadimaPayment(a.ref, { amount: 103 });
  const res = fakeRes();
  await payPage({ query: { invoice: 'inv022' } }, res);
  assert.match(res.body, /Payment received/);
  assert.equal(get('invoices/inv022').status, 'paid');
});

test('a card payment on an invoice already paid in cash is kept for review, not auto-refunded', async () => {
  const inv = newInvoice('inv023');
  const { ref } = await K.createKadimaPage(CREDS, 'inv023', inv);
  patch('invoices/inv023', { status: 'paid', payments: [{ amount: 100, method: 'cash', paymentId: 'cash1' }] });
  kadimaPayment(ref, { amount: 100 });
  await K.syncKadimaInvoice(CREDS, 'inv023');
  assert.equal(kadima.refunds.length, 0);
  assert.equal(get('invoices/inv023').paymentNeedsReview, true);
});

// ── Webhook (/api/kadima/webhook/{farrierId}) ──
const hookRes = () => { const r = fakeRes(); r.json = (b) => { r.body = b; return r; }; return r; };
const hookEvent = (ref, extra = {}) => ({ id: 9001, module: 'transaction', action: 'create', date: '2026-11-17 22:40:00', data: { externalId: ref }, ...extra });
const deliver = async (evt, headers = {}) => {
  const res = hookRes();
  await K.kadimaWebhook({ headers }, res, Buffer.from(JSON.stringify(evt)), FARRIER);
  return res;
};

test('webhook: a signed "payment created" event records the payment right away', async () => {
  patch(`farrierSecrets/${FARRIER}`, { kadimaWebhookSecret: 'whsec_test_123' });
  const inv = newInvoice('inv030');
  const { ref } = await K.createKadimaPage(CREDS, 'inv030', inv);
  kadimaPayment(ref, { amount: 100 });
  const evt = hookEvent(ref);
  const res = await deliver(evt, { 'webhook-signature': K.kadimaSignature('whsec_test_123', evt) });
  assert.equal(res.statusCode, 200);
  assert.equal(get('invoices/inv030').status, 'paid');
});

test('webhook: a wrong signature is refused and changes nothing', async () => {
  patch(`farrierSecrets/${FARRIER}`, { kadimaWebhookSecret: 'whsec_test_123' });
  const inv = newInvoice('inv031');
  const { ref } = await K.createKadimaPage(CREDS, 'inv031', inv);
  kadimaPayment(ref, { amount: 100 });
  const evt = hookEvent(ref);
  assert.equal((await deliver(evt, { 'webhook-signature': K.kadimaSignature('guess', evt) })).statusCode, 401);
  assert.equal((await deliver(evt)).statusCode, 401);
  assert.equal(get('invoices/inv031').status, 'outstanding');
});

test('webhook: the signature formula matches Kadima docs (sha512 of secret+id+module+action+date)', async () => {
  const { createHash } = await import('node:crypto');
  const evt = hookEvent('FTabcdefghijklmnopqr');
  assert.equal(K.kadimaSignature('s3cret', evt), createHash('sha512').update('s3cret9001transactioncreate2026-11-17 22:40:00').digest('hex'));
});

test('webhook: a forged event can never mark anything paid (Kadima is always asked)', async () => {
  const inv = newInvoice('inv032');
  const { ref } = await K.createKadimaPage(CREDS, 'inv032', inv);
  // no signature saved, and Kadima has no payment for this form
  const res = await deliver(hookEvent(ref, { data: { externalId: ref, amount: '100.00', status: { status: 'Approved' } } }));
  assert.equal(res.statusCode, 200);
  assert.equal(get('invoices/inv032').status, 'outstanding');
});

test('webhook: catches a double charge on a tab nobody came back from, and refunds it', async () => {
  const inv = newInvoice('inv033', { cardPriceRate: 0.03 });
  const a = await K.createKadimaPage(CREDS, 'inv033', inv);
  const b = await K.createKadimaPage(CREDS, 'inv033', { ...get('invoices/inv033'), cardFeeWaived: true });
  patch('invoices/inv033', { cardFeeWaived: true });
  kadimaPayment(a.ref, { amount: 103 });
  await deliver(hookEvent(a.ref));
  const dup = kadimaPayment(b.ref, { amount: 100 });
  await deliver(hookEvent(b.ref, { id: 9002 }));
  assert.equal(get('invoices/inv033').status, 'paid');
  assert.equal(kadima.refunds.length, 1);
  assert.equal(kadima.refunds[0].id, String(dup.id));
});

test('webhook: other events are acknowledged and ignored; events without a reference check recent forms', async () => {
  assert.equal((await deliver({ id: 1, module: 'ach', action: 'create', date: 'x' })).body.ignored, 'ach/create');
  const inv = newInvoice('inv034');
  const { ref } = await K.createKadimaPage(CREDS, 'inv034', inv);
  kadimaPayment(ref, { amount: 100 });
  await deliver({ id: 2, module: 'transaction', action: 'create', date: 'x', data: {} });
  assert.equal(get('invoices/inv034').status, 'paid');
});

test('webhook: unknown farrier or Kadima not connected → 404', async () => {
  store.delete(`farrierSecrets/${FARRIER}`);
  assert.equal((await deliver(hookEvent('FTabcdefghijklmnopqr'))).statusCode, 404);
});

test('webhook: the signature is also accepted upper-case or base64-encoded', async () => {
  patch(`farrierSecrets/${FARRIER}`, { kadimaWebhookSecret: 'whsec_test_123' });
  const inv = newInvoice('inv035');
  const { ref } = await K.createKadimaPage(CREDS, 'inv035', inv);
  kadimaPayment(ref, { amount: 100 });
  const evt = hookEvent(ref);
  const hex = K.kadimaSignature('whsec_test_123', evt);
  assert.equal((await deliver(evt, { 'webhook-signature': hex.toUpperCase() })).statusCode, 200);
  assert.equal((await deliver(evt, { 'webhook-signature': Buffer.from(hex, 'hex').toString('base64') })).statusCode, 200);
  assert.equal(get('invoices/inv035').status, 'paid');
});

test('a double charge logged for review earlier (before auto-refunds) is refunded on the next check', async () => {
  const inv = newInvoice('inv036');
  const { ref } = await K.createKadimaPage(CREDS, 'inv036', inv);
  const first = kadimaPayment(ref, { amount: 100 });
  await K.syncKadimaInvoice(CREDS, 'inv036');
  // The old code logged the second charge as "unapplied" for review and stopped there:
  const dup = kadimaPayment(ref, { amount: 100 });
  store.set(`invoices/inv036/payments/kadima_${dup.id}`, { source: 'kadima', amountCents: 10000, creditCents: 0, unapplied: true });
  patch('invoices/inv036', { paymentNeedsReview: true });
  const r = await K.syncKadimaInvoice(CREDS, 'inv036');
  assert.equal(r.reversed, 1);
  assert.equal(kadima.refunds.length, 1);
  assert.equal(kadima.refunds[0].id, String(dup.id));
  assert.equal(get(`invoices/inv036/payments/kadima_${dup.id}`).reversed, true);
  assert.equal(get('invoices/inv036').payments[0].paymentId, `kadima_${first.id}`);
  await K.syncKadimaInvoice(CREDS, 'inv036');
  assert.equal(kadima.refunds.length, 1); // never twice
});

test('webhook: Settings can show when the last notification came and whether it was signed right', async () => {
  patch(`farrierSecrets/${FARRIER}`, { kadimaWebhookSecret: 'whsec_test_123' });
  const evt = { id: 7, module: 'ping', action: 'test', date: 'x' };
  await deliver(evt, { 'webhook-signature': 'nope' });
  assert.equal(get(`farrierSecrets/${FARRIER}`).kadimaWebhookLast.result, 'bad signature');
  await deliver(evt, { 'webhook-signature': K.kadimaSignature('whsec_test_123', evt) });
  assert.equal(get(`farrierSecrets/${FARRIER}`).kadimaWebhookLast.result, 'ok');
});

test('a payment still in progress is NOT reported as a decline (417342 on 2026-11-19)', async () => {
  const inv = newInvoice('inv040');
  const { ref } = await K.createKadimaPage(CREDS, 'inv040', inv, { method: 'card_keyed' });
  // The keyed-card poll catches the payment before Kadima has approved and captured it.
  for (const status of ['Pending', 'Processing', 'In Progress', 'Approved']) {
    kadima.payments = [];
    kadimaPayment(ref, { amount: 100, status, captured: false });
    const r = await K.syncKadimaPayment(CREDS, 'inv040', ref);
    assert.deepEqual([status, r.paid, !!r.declined], [status, false, false]);
  }
  // A second later it's approved and captured: recorded as paid.
  kadima.payments = [];
  kadimaPayment(ref, { amount: 100 });
  const r = await K.syncKadimaPayment(CREDS, 'inv040', ref);
  assert.equal(r.paid, true);
  assert.equal(get('invoices/inv040').status, 'paid');
});

test('clear declines are still reported as declines', async () => {
  for (const status of ['Decline', 'Declined', 'Failed', 'Error']) {
    store.clear(); store.set(`farrierSecrets/${FARRIER}`, { ...secrets }); kadima.payments = [];
    const inv = newInvoice('inv041');
    const { ref } = await K.createKadimaPage(CREDS, 'inv041', inv);
    kadimaPayment(ref, { amount: 100, status, captured: false, reason: 'Do not honor' });
    const r = await K.syncKadimaPayment(CREDS, 'inv041', ref);
    assert.deepEqual([status, r.declined, r.message], [status, true, 'Do not honor']);
  }
});


// ── Receipt link + receipt page ──
test('the "payment received" text links to the receipt', async () => {
  const inv = newInvoice('inv050', { customerPhone: '+15615550100', customerName: 'Jane Smith' });
  const { ref } = await K.createKadimaPage(CREDS, 'inv050', inv);
  kadimaPayment(ref, { amount: 100 });
  await K.syncKadimaInvoice(CREDS, 'inv050');
  assert.equal(kadima.texts.length, 1);
  assert.equal(kadima.texts[0].to, '+15615550100');
  assert.match(kadima.texts[0].body, /^Hi Jane, your payment of \$100\.00 for invoice #1001 has been received\. View your receipt: https:\/\/app\.farritech\.com\/pay\/inv050 /);
  await K.syncKadimaInvoice(CREDS, 'inv050');
  assert.equal(kadima.texts.length, 1); // once only
});

test('a paid invoice\'s pay link shows the receipt: business, lines, total, card, PAID', async () => {
  store.set(`farriers/${FARRIER}`, { businessName: 'Spatz Farrier Co', phone: '(561) 555-0199', email: 'shoes@spatzfarrier.com',
    address: '100 Barn Rd', city: 'Wellington', state: 'FL', zip: '33414', logoUrl: 'https://cdn.example.com/spatz-logo.png' });
  const inv = newInvoice('inv051', { customerName: 'Jane Smith', items: [
    { description: 'Full Set', horseName: 'Bella', unitPrice: 180, qty: 1, amount: 180 },
    { description: 'Trim', horseName: 'Duke', unitPrice: 50, qty: 1, amount: 50 },
  ], total: 230 });
  const { ref } = await K.createKadimaPage(CREDS, 'inv051', inv);
  kadimaPayment(ref, { amount: 230 });
  await K.syncKadimaInvoice(CREDS, 'inv051');
  const res = fakeRes();
  await payPage({ query: { invoice: 'inv051' } }, res);
  for (const want of ['Invoice paid', 'Spatz Farrier Co', '100 Barn Rd, Wellington, FL 33414', '(561) 555-0199', 'tel:5615550199', 'shoes@spatzfarrier.com',
    'https://cdn.example.com/spatz-logo.png', 'Invoice #1001', 'Bill to: Jane Smith', 'Full Set', 'Bella', 'Trim', 'Duke', '$230.00', 'Visa ending 1111', '>PAID<', 'Powered by FarriTech']) {
    assert.ok(res.body.includes(want), `receipt should include ${want}`);
  }
  // The farrier's business is at the top, not FarriTech's logo.
  assert.ok(!res.body.includes('pay-logo.png'));
  const body = res.body.slice(res.body.indexOf('<body>'));
  assert.ok(body.indexOf('Spatz Farrier Co') < body.indexOf('<h1>Invoice paid'));
  // Only https logos are shown.
  patch(`farriers/${FARRIER}`, { logoUrl: 'javascript:alert(1)' });
  const res3 = fakeRes();
  await payPage({ query: { invoice: 'inv051' } }, res3);
  assert.ok(!res3.body.includes('javascript:alert'));
  // HTML in invoice data is escaped, never rendered.
  patch('invoices/inv051', { customerName: '<script>alert(1)</script>' });
  const res2 = fakeRes();
  await payPage({ query: { invoice: 'inv051' } }, res2);
  assert.ok(!res2.body.includes('<script>alert(1)</script>'));
  assert.ok(res2.body.includes('&lt;script&gt;'));
});


test('pages that belong to no farrier still show the FarriTech logo', async () => {
  const res = fakeRes();
  await payPage({ query: { invoice: 'doesNotExist01' } }, res);
  assert.match(res.body, /Invoice not found/);
  assert.ok(res.body.includes('pay-logo.png'));
});
