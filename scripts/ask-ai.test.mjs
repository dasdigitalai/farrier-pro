// Tests for Ask FarriTech: node --test scripts/ask-ai.test.mjs  (no network, no Firestore, no API key)
import test from 'node:test';
import assert from 'node:assert/strict';
import { getMoneyOwed, countCustomers, countHorsesServiced, namedRanges, localDate, ToolInputError } from '../api/_lib/ask-tools.js';
import { askAI, systemPrompt } from '../api/_lib/ask-ai.js';

const TZ = 'America/New_York';
const TODAY = '2026-11-02'; // a Monday
const ctx = { today: TODAY, tz: TZ };

const invoices = [
  { id: 'i1', status: 'outstanding', total: 240, customerId: 'c1', customerName: 'Jane Smith', createdAt: '2026-11-02T15:00:00Z',
    items: [{ description: 'Full Set', horseId: 'h1', horseName: 'Rex' }, { description: 'Full Set', horseId: 'h2', horseName: 'Dot' }] },
  { id: 'i2', status: 'partial', total: 300, customerId: 'c2', customerName: 'Bob Jones', createdAt: '2026-10-20T15:00:00Z',
    payments: [{ amount: 100, creditAmount: 100 }], items: [{ description: 'Trim', horseId: 'h3', horseName: 'Moe' }] },
  { id: 'i3', status: 'paid', total: 500, customerId: 'c1', customerName: 'Jane Smith', createdAt: '2026-10-28T15:00:00Z', paidAmount: 500,
    items: [{ description: 'Full Set', horseId: 'h1', horseName: 'Rex' }, { description: 'Trim', horseId: 'h4', horseName: 'Lu' }, { description: 'Trip fee' }] },
  { id: 'i4', status: 'cancelled', total: 999, customerId: 'c3', customerName: 'Cancelled Cathy', createdAt: '2026-10-28T15:00:00Z', items: [{ description: 'Full Set', horseId: 'h9' }] },
  // 10pm Sunday Nov 1 in New York is already Monday in UTC: must count as LAST week.
  { id: 'i5', status: 'paid', total: 100, customerName: 'No Id Nate', createdAt: '2026-11-02T03:00:00Z', items: [{ description: 'Reset', horseName: 'Biscuit' }] },
];
const customers = [{ id: 'c1', name: 'Jane Smith' }, { id: 'c2', name: 'Bob Jones' }, { id: 'c3', name: 'Cancelled Cathy' }, { id: 'c4', name: 'Dormant Dan' }, { id: 'c5', name: 'No Id Nate' }];
const appointments = [{ id: 'a1', customerId: 'c4', requestedDate: '2026-12-01', status: 'confirmed' }, { id: 'a2', customerName: 'Dormant Dan', requestedDate: '2025-01-01', status: 'completed' }];
const data = { invoices, customers, appointments };

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
  const r = getMoneyOwed({ invoices: [invoices[2]] }, ctx, {});
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
