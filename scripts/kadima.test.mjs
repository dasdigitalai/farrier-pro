// Tests for the Kadima card processor (api/_lib/kadima.js + the Kadima branch of the pay page).
//   node --test --experimental-test-module-mocks scripts/kadima.test.mjs
// No network and no Firestore: firebase-rest.js is replaced by an in-memory store, and every
// fetch goes to a fake Kadima. Any other host fails the test, so nothing can reach live data.
import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

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
const kadima = { payments: [], forms: [], refunds: [], requests: [], tokenOk: true, nextId: 500000 };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const body = init.body ? JSON.parse(init.body) : undefined;
  kadima.requests.push({ method: init.method || 'GET', host: url.host, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: init.headers?.Authorization });
  if (!['sandbox-gateway.kadimadashboard.com', 'sandbox.kadimadashboard.com'].includes(url.host)) {
    throw new Error(`test tried to reach ${url.host}`);
  }
  if (!kadima.tokenOk) return json(401, { name: 'Unauthorized', message: 'Your request was made with invalid credentials.', status: 401 });
  if (url.pathname === '/payments') {
    const ext = url.searchParams.get('filter[externalId][eq]');
    const items = ext ? kadima.payments.filter(p => p.externalId === ext) : kadima.payments.slice(0, 1);
    return json(200, { items, _meta: { totalCount: items.length } });
  }
  if (url.pathname === '/api/gateway/hosted-form' && init.method === 'POST') {
    kadima.forms.push(body);
    return json(200, { code: '<div></div>', url: `https://sandbox.kadimadashboard.com/gateway/public/form?data=x&externalId=${body.externalId}&amount=${body.amount}` });
  }
  const refund = url.pathname.match(/^\/payment\/(\d+)\/refund$/);
  if (refund && init.method === 'POST') {
    kadima.refunds.push({ id: refund[1], ...body });
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
  Object.assign(kadima, { payments: [], forms: [], refunds: [], requests: [], tokenOk: true });
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
  assert.equal(form.returnUrlNavigation, 'top');
  const saved = get('invoices/inv001');
  assert.equal(saved.kadimaOpenRef, ref);
  assert.equal(saved.kadimaLinks[ref].chargeCents, 10300);
  assert.equal(saved.kadimaLinks[ref].creditCents, 10000);
});

test('keyed card forms stay inside the app frame and are never reused for the customer link', async () => {
  const inv = newInvoice('inv002');
  const { chargeCents } = await K.createKadimaPage(CREDS, 'inv002', inv, { method: 'card_keyed', applyCents: 4000 });
  assert.equal(chargeCents, 4000);
  assert.equal(kadima.forms[0].returnUrlNavigation, 'self');
  assert.equal(K.reusableKadimaPage(get('invoices/inv002'), 4000), null);
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
  assert.equal(second.duplicate, true);
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
  assert.equal(get('invoices/inv006').kadimaOpenRef, '');
});

test('a Kadima payment that lands on an already-paid invoice is kept for review, not lost', async () => {
  const inv = newInvoice('inv007');
  const { ref } = await K.createKadimaPage(CREDS, 'inv007', inv);
  patch('invoices/inv007', { status: 'paid' }); // farrier recorded cash meanwhile
  const p = kadimaPayment(ref, { amount: 100 });
  const r = await K.syncKadimaPayment(CREDS, 'inv007', ref);
  assert.equal(r.alreadyPaid, true);
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

test('no request ever left for a host other than the Kadima sandbox', () => {
  // (the fetch stub throws for any other host; this documents it)
  assert.ok(kadima.requests.every(r => r.host.endsWith('kadimadashboard.com')));
});
