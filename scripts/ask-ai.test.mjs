// Tests for Ask FarriTech: node --test scripts/ask-ai.test.mjs  (no network, no Firestore, no API key)
import test from 'node:test';
import assert from 'node:assert/strict';
import { getMoneyOwed, getMoneyCollected, countCustomers, countHorsesServiced, findHorse, findCustomers, namedRanges, localDate, ToolInputError } from '../api/_lib/ask-tools.js';
import { askAI, systemPrompt } from '../api/_lib/ask-ai.js';

const TZ = 'America/New_York';
const TODAY = '2026-11-02'; // a Monday
const ctx = { today: TODAY, tz: TZ };

const invoices = [
  { id: 'i6', status: 'paid', total: 120, customerId: 'c1', customerName: 'Jane Smith', createdAt: '2026-09-01T15:00:00Z', paidAmount: 120, items: [{ description: 'Full Set', horseId: 'hb1', horseName: 'Bonnie' }] },
  { id: 'i7', status: 'paid', total: 170, customerId: 'c1', customerName: 'Jane Smith', createdAt: '2026-10-13T15:00:00Z', paidAmount: 170, items: [{ description: 'Full Set', horseId: 'hb1', horseName: 'Bonnie' }, { description: 'Trim', horseId: 'h1', horseName: 'Rex' }] },
  { id: 'i1', status: 'outstanding', total: 240, customerId: 'c1', customerName: 'Jane Smith', createdAt: '2026-11-02T15:00:00Z',
    items: [{ description: 'Full Set', horseId: 'h1', horseName: 'Rex' }, { description: 'Full Set', horseId: 'h2', horseName: 'Dot' }] },
  { id: 'i2', status: 'partial', total: 300, customerId: 'c2', customerName: 'Bob Jones', createdAt: '2026-10-20T15:00:00Z',
    payments: [{ amount: 100, creditAmount: 100, date: '2026-10-27T14:00:00Z', method: 'cash' }], items: [{ description: 'Trim', horseId: 'h3', horseName: 'Moe' }] },
  { id: 'i3', status: 'paid', total: 500, customerId: 'c1', customerName: 'Jane Smith', createdAt: '2026-10-28T15:00:00Z', paidAmount: 500, paidAt: '2026-10-29T16:00:00Z', paymentMethod: 'check', refunds: [{ amount: 50, date: '2026-10-30T12:00:00Z' }],
    items: [{ description: 'Full Set', horseId: 'h1', horseName: 'Rex' }, { description: 'Trim', horseId: 'h4', horseName: 'Lu' }, { description: 'Trip fee' }] },
  { id: 'i4', status: 'cancelled', total: 999, customerId: 'c3', customerName: 'Cancelled Cathy', createdAt: '2026-10-28T15:00:00Z', payments: [{ amount: 999, date: '2026-10-28T15:00:00Z', method: 'cash' }], items: [{ description: 'Full Set', horseId: 'h9' }] },
  // 10pm Sunday Nov 1 in New York is already Monday in UTC: must count as LAST week.
  { id: 'i5', status: 'paid', total: 100, customerName: 'No Id Nate', createdAt: '2026-11-02T03:00:00Z', items: [{ description: 'Reset', horseName: 'Biscuit' }] },
];
const customers = [
  { id: 'c1', name: 'Jane Smith', farmName: 'Sunny Acres', city: 'Loxahatchee', address: '100 Southern Blvd', zip: '33470', state: 'FL' },
  { id: 'c2', name: 'Bob Jones', farmName: 'Jones Polo', city: 'Loxahatchee Groves', address: '5 B Rd', zip: '33470', state: 'FL' },
  { id: 'c3', name: 'Cancelled Cathy', city: 'Wellington', address: '9 Pierson Rd', zip: '33414', state: 'FL' },
  { id: 'c4', name: 'Dormant Dan', farmName: 'Dan Stables', city: 'Wellington', address: '1 Flamingo Rd', zip: '33414', state: 'FL' },
  { id: 'c5', name: 'No Id Nate' }, // no address on file
];
const horses = [
  { id: 'hb1', name: 'Bonnie', customerName: 'Jane Smith', lastServiceDate: '2026-10-13T15:00:00Z' },
  { id: 'hb2', name: 'Bonnie', customerName: 'Bob Jones' },
  { id: 'h1', name: 'Rex', customerName: 'Jane Smith' },
];
const appointments = [{ id: 'a1', customerId: 'c4', requestedDate: '2026-12-01', status: 'confirmed' }, { id: 'a2', customerName: 'Dormant Dan', requestedDate: '2025-01-01', status: 'completed' }];
const data = { invoices, customers, appointments, horses };

test('local dates use the business timezone, not UTC', () => {
  assert.equal(localDate('2026-11-02T03:00:00Z', TZ), '2026-11-01');
  assert.equal(localDate('2026-11-02T15:00:00Z', TZ), '2026-11-02');
  assert.equal(localDate('2026-11-02', TZ), '2026-11-02');
  assert.equal(localDate('garbage', TZ), null);
});

test('named ranges: weeks run Monday to Sunday', () => {
  const r = namedRanges(TODAY);
  assert.deepEqual(r['this week (Mon–Sun)'], ['2026-11-02', '2026-11-08']);
  assert.deepEqual(r['last week (Mon–Sun)'], ['2026-10-26', '2026-11-01']);
  assert.deepEqual(r['this month'], ['2026-11-01', '2026-11-30']);
  assert.deepEqual(r['last month'], ['2026-10-01', '2026-10-31']);
  assert.deepEqual(namedRanges('2026-01-03')['last month'], ['2025-12-01', '2025-12-31']); // year boundary
  assert.deepEqual(namedRanges('2026-12-31')['this month'], ['2026-12-01', '2026-12-31']);
});

test('who owes me: all-time, ignores paid and cancelled, counts part-paid balance only', () => {
  const r = getMoneyOwed(data, ctx, {});
  assert.equal(r.all_time.total_owed, 440); // 240 + (300 - 100)
  assert.equal(r.all_time.unpaid_invoices, 2);
  assert.deepEqual(r.all_time.customers.map(c => [c.customer, c.owed]), [['Jane Smith', 240], ['Bob Jones', 200]]);
  assert.equal(r.all_time.customers[1].oldest_invoice_days, 13);
});

test('who owes me this week: only invoices dated in range, plus the all-time total', () => {
  const r = getMoneyOwed(data, ctx, { from: '2026-11-02', to: '2026-11-08' });
  assert.equal(r.invoiced_in_range.total_owed, 240);
  assert.deepEqual(r.invoiced_in_range.customers.map(c => c.customer), ['Jane Smith']);
  assert.equal(r.all_time.total_owed, 440);
  assert.equal(r.all_time.customers, undefined);
});

test('who owes me: nobody owes anything', () => {
  const r = getMoneyOwed({ invoices: [invoices.find(i => i.id === 'i3')] }, ctx, {});
  assert.equal(r.all_time.total_owed, 0);
  assert.deepEqual(r.all_time.customers, []);
});

test('active customers: invoice or appointment within the window, matched by id or name', () => {
  const r = countCustomers(data, ctx, {});
  assert.equal(r.total_customers, 5);
  // c1 (invoice), c2 (invoice), c3 (only a cancelled invoice: no), c4 (future appointment), c5 (invoice by name)
  assert.equal(r.active_customers, 4);
  assert.equal(r.not_active, 1);
  assert.equal(countCustomers(data, ctx, { active_within_days: 1 }).active_customers, 3); // c1, c4, c5 on/after Nov 1
  assert.throws(() => countCustomers(data, ctx, { active_within_days: 0 }), ToolInputError);
});

test('horses serviced: distinct horses, cancelled excluded, timezone-correct, by service', () => {
  const lastWeek = countHorsesServiced(data, ctx, { from: '2026-10-26', to: '2026-11-01' });
  // i3 (Rex, Lu, trip fee) + i5 (Biscuit, 10pm Sunday NY). i4 cancelled. i1 is this week.
  assert.equal(lastWeek.horses_serviced, 3);
  assert.equal(lastWeek.invoices_in_range, 2);
  assert.equal(lastWeek.lines_without_a_horse, 1);
  assert.deepEqual(lastWeek.by_service.map(s => [s.service, s.horses]), [['Full Set', 1], ['Reset', 1], ['Trim', 1]]);

  const thisWeek = countHorsesServiced(data, ctx, { from: '2026-11-02', to: '2026-11-08' });
  assert.equal(thisWeek.horses_serviced, 2);

  // The same horse on two invoices counts once.
  const twice = countHorsesServiced(data, ctx, { from: '2026-10-26', to: '2026-11-08' });
  assert.equal(twice.horses_serviced, 4); // Rex (on i1 AND i3, counted once), Dot, Lu, Biscuit
});

test('money collected: payments by the day they were made, refunds apart, cancelled ignored', () => {
  const r = getMoneyCollected(data, ctx, { from: '2026-10-26', to: '2026-11-01' });
  // i2 cash $100 (payments[]), i3 check $500 (legacy paidAmount on paidAt), i5 $100 (no paidAt: falls back to the invoice day, 10pm Sunday NY).
  // i4 is cancelled (its $999 is ignored); i1 is unpaid.
  assert.equal(r.total_collected, 700);
  assert.equal(r.payments, 3);
  assert.equal(r.refunds, 50);
  assert.equal(r.collected_after_refunds, 650);
  assert.deepEqual(r.by_method, [{ method: 'Cash', collected: 100 }, { method: 'Check', collected: 500 }, { method: 'Zelle, Venmo & other', collected: 100 }]);
  // Invoiced in the same range: i2 (Oct 20) no, i3 $500 (Oct 28) + i5 $100 (Nov 1 NY) = 600; i1 is Nov 2.
  assert.equal(r.for_comparison_invoiced_in_range, 600);
  assert.equal(r.invoices_created_in_range, 2);
});

test('money collected: a quiet period is zero, not an error; card payments are labelled Card', () => {
  const none = getMoneyCollected(data, ctx, { from: '2026-01-01', to: '2026-01-31' });
  assert.equal(none.total_collected, 0);
  assert.deepEqual(none.by_method, []);
  const card = getMoneyCollected({ invoices: [{ id: 'x', status: 'paid', total: 103, createdAt: '2026-11-02T15:00:00Z', payments: [{ amount: 103, date: '2026-11-02T15:00:00Z', method: 'card_link' }] }] }, ctx, { from: '2026-11-02', to: '2026-11-02' });
  assert.deepEqual(card.by_method, [{ method: 'Card', collected: 103 }]);
  assert.throws(() => getMoneyCollected(data, ctx, { from: '2026-11-05', to: '2026-11-01' }), ToolInputError);
});

test('horses serviced: a "Multiple horses" line counts its quantity, not one horse', () => {
  const inv = [
    { id: 'm1', status: 'paid', total: 600, customerId: 'c1', createdAt: '2026-11-03T15:00:00Z', items: [
      { description: 'Full Set', horseName: 'Multiple horses', qty: 12, note: 'polo string' },
      { description: 'Full Set', horseId: 'h1', horseName: 'Rex' } ] },
    { id: 'm2', status: 'paid', total: 100, customerId: 'c1', createdAt: '2026-11-04T15:00:00Z', items: [{ description: 'Trim', horseName: 'Multiple horses', qty: 3 }] },
  ];
  const r = countHorsesServiced({ invoices: inv }, ctx, { from: '2026-11-02', to: '2026-11-08' });
  assert.equal(r.horses_serviced, 16); // 12 + Rex + 3
  assert.equal(r.horses_in_multi_horse_lines, 15);
  assert.deepEqual(r.by_service, [{ service: 'Full Set', horses: 13 }, { service: 'Trim', horses: 3 }]);
  // A line with no qty (older invoices) is one horse.
  const one = countHorsesServiced({ invoices: [{ id: 'o', status: 'paid', createdAt: '2026-11-03T15:00:00Z', items: [{ description: 'Trim', horseName: 'Multiple horses' }] }] }, ctx, { from: '2026-11-02', to: '2026-11-08' });
  assert.equal(one.horses_serviced, 1);
});

test('find horse: "did I ever shoe Bonnie" - history, owner, services, and a second Bonnie on file', () => {
  const r = findHorse(data, ctx, { name: 'bonnie' });
  assert.equal(r.horses_found, 2);
  const jane = r.horses[0]; // most recently invoiced first
  assert.equal(jane.customer, 'Jane Smith');
  assert.equal(jane.invoices, 2);
  assert.equal(jane.first_invoiced, '2026-09-01');
  assert.equal(jane.last_invoiced, '2026-10-13');
  assert.deepEqual(jane.services, [{ service: 'Full Set', times: 2 }]);
  assert.deepEqual(jane.recent_visits.map(v => v.date), ['2026-10-13', '2026-09-01']);
  const bob = r.horses[1]; // on file, never invoiced
  assert.equal(bob.customer, 'Bob Jones');
  assert.equal(bob.invoices, 0);
  assert.equal(bob.note, 'On file, but on no invoice.');
});

test('find horse: not found is an empty list; "Bonnie Blue" is not Bonnie when a Bonnie is on file; bad input rejected', () => {
  assert.equal(findHorse(data, ctx, { name: 'Zorro' }).horses_found, 0);
  const blue = findHorse({ invoices: [...invoices, { id: 'ib', status: 'paid', customerName: 'Z', createdAt: '2026-10-01T15:00:00Z', items: [{ description: 'Trim', horseName: 'Bonnie Blue' }] }], horses }, ctx, { name: 'Bonnie' });
  assert.equal(blue.horses_found, 2); // Bonnie Blue's trim is not counted as Bonnie's
  // With no Bonnie on file at all, a looser match finds "Bonnie Blue" from the invoice line alone.
  const loose = findHorse({ invoices: [{ id: 'ib', status: 'paid', customerName: 'Z', createdAt: '2026-10-01T15:00:00Z', items: [{ description: 'Trim', horseName: 'Bonnie Blue' }] }], horses: [] }, ctx, { name: 'Bonnie' });
  assert.equal(loose.horses[0].horse, 'Bonnie Blue');
  // Cancelled invoices don't count as work done.
  assert.equal(findHorse({ invoices: [{ id: 'ic', status: 'cancelled', customerName: 'Z', createdAt: '2026-10-01T15:00:00Z', items: [{ description: 'Trim', horseName: 'Ghost' }] }], horses: [] }, ctx, { name: 'Ghost' }).horses_found, 0);
  assert.throws(() => findHorse(data, ctx, { name: 'a' }), ToolInputError);
});

test('find customers: "what farms do I have in Loxahatchee" matches city, partial city, ZIP and street; never phone/email', () => {
  const r = findCustomers(data, ctx, { place: 'Loxahatchee' });
  assert.equal(r.matches, 2); // Loxahatchee and Loxahatchee Groves
  assert.deepEqual(r.customers.map(c => c.farm), ['Jones Polo', 'Sunny Acres']);
  assert.equal(r.with_a_farm_name, 2);
  assert.equal(findCustomers(data, ctx, { place: '33470' }).matches, 2);
  assert.equal(findCustomers(data, ctx, { place: 'southern blvd' }).matches, 1);
  assert.deepEqual(findCustomers(data, ctx, { place: 'Wellington' }).customers.map(c => c.customer), ['Cancelled Cathy', 'Dormant Dan']); // sorted by farm name, else customer name
  assert.equal(findCustomers(data, ctx, { place: 'FL' }).matches, 4); // customers with state FL
  assert.equal(findCustomers(data, ctx, { place: 'wellington', name: 'dan' }).matches, 1);
  assert.equal(findCustomers(data, ctx, { place: 'Nowhere' }).matches, 0);
  assert.equal(Object.keys(r.customers[0]).sort().join(), 'address,city,customer,farm');
  assert.throws(() => findCustomers(data, ctx, {}), ToolInputError);
});

test('bad date input is rejected as the model\'s mistake', () => {
  assert.throws(() => countHorsesServiced(data, ctx, { from: '2026-13-01', to: '2026-11-01' }), ToolInputError);
  assert.throws(() => countHorsesServiced(data, ctx, { from: '2026-11-05', to: '2026-11-01' }), ToolInputError);
  assert.throws(() => countHorsesServiced(data, ctx, {}), ToolInputError);
  assert.throws(() => getMoneyOwed(data, ctx, { from: '2026-11-01' }), ToolInputError);
});

// ── The Claude loop, with a scripted stand-in for the API ──
const caller = { uid: 'u1', idToken: 'tok' };
const biz = { businessId: 'u1', role: 'owner' };
const now = new Date('2026-11-02T17:00:00Z');
const load = async (name) => data[name];
function fakeClient(script) {
  const calls = [];
  return { calls, messages: { create: async (req) => { calls.push(structuredClone(req)); return script[calls.length - 1]; } } };
}
const toolUse = (name, input, id = 't1') => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

test('askAI: runs the chosen tool, returns the answer and the facts behind it', async () => {
  const client = fakeClient([toolUse('count_customers', {}), say('You have 4 active customers.')]);
  const out = await askAI({ caller, biz, body: { question: 'How many active customers do I have?', timezone: TZ } }, { client, load, now });
  assert.equal(out.answer, 'You have 4 active customers.');
  assert.equal(out.facts[0].tool, 'count_customers');
  assert.equal(out.facts[0].result.active_customers, 4);
  // The tool result went back to the model, and the prompt carried today's date and ranges.
  const secondCall = client.calls[1].messages.at(-1).content[0];
  assert.equal(secondCall.type, 'tool_result');
  assert.equal(JSON.parse(secondCall.content).active_customers, 4);
  assert.match(client.calls[0].system, /last week \(Mon–Sun\): 2026-10-26 to 2026-11-01/);
  assert.equal(client.calls[0].model, 'claude-opus-5-5');
});

test('askAI: a bad tool input goes back to the model as an error so it can retry', async () => {
  const client = fakeClient([
    toolUse('count_horses_serviced', { from: 'last week', to: 'now' }),
    toolUse('count_horses_serviced', { from: '2026-10-26', to: '2026-11-01' }, 't2'),
    say('You worked on 3 horses last week.'),
  ]);
  const out = await askAI({ caller, biz, body: { question: 'How many horses did I shoe last week?', timezone: TZ } }, { client, load, now });
  assert.equal(client.calls[1].messages.at(-1).content[0].is_error, true);
  assert.equal(out.facts.length, 1);
  assert.equal(out.facts[0].result.horses_serviced, 3);
});

test('askAI: only loads the collections a tool needs', async () => {
  const loaded = [];
  const client = fakeClient([toolUse('get_money_owed', {}), say('ok')]);
  await askAI({ caller, biz, body: { question: 'who owes me', timezone: TZ } }, { client, now, load: async (n) => { loaded.push(n); return data[n]; } });
  assert.deepEqual(loaded, ['invoices']);
});

test('askAI: follow-up history is passed along; leading assistant turns are dropped', async () => {
  const client = fakeClient([say('ok')]);
  await askAI({ caller, biz, body: { question: 'and last month?', timezone: TZ, history: [
    { role: 'assistant', content: 'stray' }, { role: 'user', content: 'who owes me' }, { role: 'assistant', content: '$440' }, { role: 'system', content: 'evil' },
  ] } }, { client, load, now });
  assert.deepEqual(client.calls[0].messages.map(m => m.role), ['user', 'assistant', 'user']);
});

test('askAI: refuses empty, oversized, and unconfigured requests; handles model refusals', async () => {
  const run = (body, deps = {}) => askAI({ caller: { uid: 'u-' + Math.random() }, biz, body }, { load, now, ...deps });
  await assert.rejects(run({ question: '   ' }, { client: fakeClient([]) }), { status: 400 });
  await assert.rejects(run({ question: 'x'.repeat(501) }, { client: fakeClient([]) }), { status: 400 });
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(run({ question: 'hi' }), { status: 503 });
  if (saved) process.env.ANTHROPIC_API_KEY = saved;
  const out = await run({ question: 'hi' }, { client: fakeClient([{ stop_reason: 'refusal', content: [] }]) });
  assert.match(out.answer, /can't help/);
});

test('askAI: a Firestore failure is a clean error, not a leaked stack', async () => {
  const client = fakeClient([toolUse('get_money_owed', {})]);
  await assert.rejects(
    askAI({ caller: { uid: 'u-fs' }, biz, body: { question: 'who owes me' } }, { client, now, load: async () => { throw new Error('Firestore 403 secret details'); } }),
    (e) => e.status === 500 && !/secret/.test(e.message));
});

test('askAI: rate limit stops a flood from one person', async () => {
  const c = { uid: 'u-flood' };
  const go = () => askAI({ caller: c, biz, body: { question: 'hi' } }, { client: fakeClient([say('ok')]), load, now });
  for (let i = 0; i < 15; i++) await go();
  await assert.rejects(go(), { status: 429 });
});

test('system prompt names today and the time zone', () => {
  assert.match(systemPrompt(TODAY, TZ), /Today is 2026-11-02 \(Monday\)/);
});
