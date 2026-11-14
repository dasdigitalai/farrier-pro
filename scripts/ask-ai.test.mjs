// Tests for Ask FarriTech: node --test scripts/ask-ai.test.mjs  (no network, no Firestore, no API key)
import test from 'node:test';
import assert from 'node:assert/strict';
import { getHorsesDue, getMoneyOwed, getMoneyCollected, getInvoiceStats, countCustomers, countHorsesServiced, findHorse, findCustomers, namedRanges, localDate, ToolInputError } from '../api/_lib/ask-tools.js';
import { askAI, systemPrompt } from '../api/_lib/ask-ai.js';
import '../lib/horse-history.js'; // the app's own next-service logic (globalThis.FarriHorseHistory), used as the reference below

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

test('invoice stats: average, median, extremes; cancelled excluded; periods; empty', () => {
  const all = getInvoiceStats(data, ctx, {});
  // Non-cancelled: 240, 300, 500, 100, 120, 170 (i4's $999 is cancelled).
  assert.equal(all.period, 'all time');
  assert.equal(all.invoices, 6);
  assert.equal(all.total_invoiced, 1430);
  assert.equal(all.average_invoice, 238.33);
  assert.equal(all.median_invoice, 205); // (170 + 240) / 2
  assert.equal(all.largest_invoice, 500);
  assert.equal(all.smallest_invoice, 100);
  const week = getInvoiceStats(data, ctx, { from: '2026-11-02', to: '2026-11-08' });
  assert.equal(week.invoices, 1); assert.equal(week.average_invoice, 240); // i5 is 10pm Sunday NY: last week
  const last = getInvoiceStats(data, ctx, { from: '2026-10-26', to: '2026-11-01' });
  assert.equal(last.average_invoice, 300); // i3 $500 and i5 $100
  const none = getInvoiceStats(data, ctx, { from: '2026-01-01', to: '2026-01-31' });
  assert.equal(none.invoices, 0); assert.equal(none.average_invoice, null);
  assert.throws(() => getInvoiceStats(data, ctx, { from: '2026-11-01' }), ToolInputError);
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

// ── Horses due ──
const dueData = (() => {
  const h = (id, name, owner, extra = {}) => ({ id, name, customerId: owner === 'Jane' ? 'c1' : 'c2', customerName: owner === 'Jane' ? 'Jane Smith' : 'Bob Jones', ...extra });
  return {
    customers: [{ id: 'c1', name: 'Jane Smith', farmName: 'Sunny Acres' }, { id: 'c2', name: 'Bob Jones' }],
    horses: [
      h('h1', 'Rex', 'Jane', { shoeingCycleWeeks: 6, lastServiceDate: '2026-09-28T15:00:00Z' }),   // due 11-09
      h('h2', 'Dot', 'Jane', { shoeingCycleWeeks: 6 }),                                            // last service from an invoice: 09-01, due 10-13 = overdue
      h('h3', 'Moe', 'Bob', { shoeingCycleWeeks: 8, lastServiceDate: '2026-10-20T15:00:00Z' }),   // due 12-15: outside 4 weeks (and a cancelled booking must not count)
      h('h4', 'Lu', 'Jane', { shoeingCycleWeeks: 6, lastServiceDate: '2026-08-30T15:00:00Z' }),   // booked 11-12
      h('h5', 'Biscuit', 'Jane', { lastServiceDate: '2026-10-01T15:00:00Z' }),                      // no cycle set
      h('h6', 'Penny', 'Jane', { shoeingCycleWeeks: 6 }),                                          // cycle set, never serviced
      h('h7', 'Atlas', 'Bob', { shoeingCycleWeeks: 4, lastServiceDate: '2026-10-05T15:00:00Z' }), // due today (11-02)
      h('h8', 'Daisy', 'Jane', { shoeingCycleWeeks: 4, lastServiceDate: '2026-11-02T15:00:00Z' }),// due 11-30 = the day the 4-week window ends: not inside it
      // no ids anywhere: matched by name + owner. Last service from a past appointment 10-01; calendar days: 10-01 + 6 weeks = 11-12.
      // (The app's Upcoming tab adds 24-hour days to midnight, so across the Nov 1 clock change it shows 11-11. Same one-day slip each spring and fall; not copied here.)
      { id: 'h9', name: 'Duke', customerName: 'Jane Smith', shoeingCycleWeeks: 6 },
    ],
    invoices: [{ id: 'iv1', status: 'paid', customerId: 'c1', customerName: 'Jane Smith', createdAt: '2026-09-01T15:00:00Z', items: [{ description: 'Full Set', horseId: 'h2', horseName: 'Dot' }] }],
    appointments: [
      { id: 'a1', status: 'confirmed', customerId: 'c1', requestedDate: '2026-11-12', horseRequests: [{ horseId: 'h4', horseName: 'Lu', services: ['Full Set'] }] },
      { id: 'a2', status: 'cancelled', customerId: 'c2', requestedDate: '2026-11-10', horseRequests: [{ horseId: 'h3', horseName: 'Moe' }] },
      { id: 'a3', status: 'completed', customerName: 'Jane Smith', requestedDate: '2026-10-01', horseRequests: [{ horseName: 'Duke', services: ['Trim'] }] },
    ],
  };
})();

test('horses due in the next 4 weeks: the Upcoming Service rules (booked, estimated, overdue, boundaries)', () => {
  const r = getHorsesDue(dueData, ctx, { weeks: 4 });
  assert.deepEqual(r.window, { from: '2026-11-02', to_before: '2026-11-30', weeks: 4 });
  assert.equal(r.horses_due, 5);
  assert.deepEqual(r.horses.map(x => [x.horse, x.due_date, x.status]), [
    ['Dot', '2026-10-13', 'overdue'], ['Atlas', '2026-11-02', 'due'], ['Rex', '2026-11-09', 'due'], ['Duke', '2026-11-12', 'due'], ['Lu', '2026-11-12', 'booked'],
  ]);
  assert.equal(r.overdue, 1); assert.equal(r.due_not_yet_booked, 3); assert.equal(r.already_booked, 1);
  assert.equal(r.owners_with_horses_due, 2);
  assert.equal(r.horses_on_file, 9);
  assert.equal(r.horses_with_no_due_date, 2); assert.equal(r.of_which_no_shoeing_cycle_set, 1); assert.equal(r.of_which_cycle_set_but_never_serviced, 1);
  assert.equal(r.horses.find(x => x.horse === 'Rex').farm, 'Sunny Acres');
  assert.equal(r.horses.find(x => x.horse === 'Rex').last_service, '2026-09-28');
});

test('horses due: the window grows with the weeks asked for, and bad input is the model\'s mistake', () => {
  const d = (w) => getHorsesDue(dueData, ctx, { weeks: w }).horses.map(x => x.horse);
  assert.ok(!d(4).includes('Daisy') && d(5).includes('Daisy'));          // 11-30 is outside 4 weeks, inside 5
  assert.ok(!d(6).includes('Moe') && d(7).includes('Moe'));              // Moe is due 12-15: 6 weeks ends 12-14, 7 weeks ends 12-21
  for (const bad of [0, 53, 2.5, '4', undefined, null]) assert.throws(() => getHorsesDue(dueData, ctx, { weeks: bad }), ToolInputError);
  assert.equal(getHorsesDue({ horses: [], appointments: [], invoices: [], customers: [] }, ctx, { weeks: 4 }).horses_due, 0);
});

// A small seeded random generator, so the comparison below is the same every run.
const rng = (seed) => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

test('horses due: agrees with the app\'s own FarriHorseHistory (Upcoming Service tab) on random data', () => {
  const savedTZ = process.env.TZ; process.env.TZ = 'America/New_York'; // the app runs in the farrier's browser time zone
  try {
    const FHH = globalThis.FarriHorseHistory;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const rand = rng(seed), pick = (a) => a[Math.floor(rand() * a.length)], int = (a, b) => a + Math.floor(rand() * (b - a + 1));
      const today = '2026-06-15'; // mid-summer: no clock change between the data and the window, where the app's 24-hour-day arithmetic would differ by a day
      const dayStr = (off) => { const d = new Date(2026, 5, 15 + off); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
      // (Around a clock change the app's 24-hour-day arithmetic is a day off and these calendar-day rules are right; see the Duke case above.)
      const stamp = (off) => new Date(2026, 5, 15 + off, int(2, 22), int(0, 59)).toISOString();
      const customers = [...Array(8)].map((_, i) => ({ id: 'c' + i, name: 'Owner ' + i, farmName: i % 2 ? 'Farm ' + i : '' }));
      const horses = [...Array(70)].map((_, i) => {
        const c = pick(customers), twin = i % 9 === 0; // some names shared by different owners
        return { id: 'h' + i, name: twin ? 'Twin' : 'Horse' + i, customerId: rand() < 0.8 ? c.id : '', customerName: c.name,
          shoeingCycleWeeks: pick([null, undefined, 0, 4, 5, 6, 8, 10]), ...(rand() < 0.7 ? { lastServiceDate: stamp(-int(1, 100)) } : {}) };
      });
      const hAny = () => pick(horses);
      const appointments = [...Array(120)].map((_, i) => {
        const hs = [hAny(), ...(rand() < 0.3 ? [hAny()] : [])], c = customers.find(x => x.id === hs[0].customerId) || pick(customers);
        const how = rand();
        return { id: 'a' + i, status: pick(['confirmed', 'completed', 'cancelled', 'pending']), customerId: rand() < 0.8 ? c.id : '', customerName: c.name, requestedDate: dayStr(int(-70, 70)),
          ...(how < 0.4 ? { horseRequests: hs.map(x => ({ horseId: x.id, horseName: x.name, services: ['Trim'] })) }
            : how < 0.7 ? { horseIds: hs.map(x => x.id) }
            : { horseRequests: hs.map(x => ({ horseName: x.name, services: ['Trim'] })) }) };
      });
      const invoices = [...Array(120)].map((_, i) => {
        const hs = [hAny(), ...(rand() < 0.3 ? [hAny()] : [])], c = customers.find(x => x.id === hs[0].customerId) || pick(customers);
        return { id: 'v' + i, status: pick(['paid', 'outstanding', 'cancelled', 'partial']), customerId: rand() < 0.8 ? c.id : '', customerName: c.name, createdAt: rand() < 0.95 ? stamp(-int(1, 110)) : undefined,
          items: hs.map(x => rand() < 0.6 ? { description: 'Full Set', horseId: x.id, horseName: x.name } : { description: 'Trim', horseName: x.name }) };
      });

      const now = new Date(2026, 5, 15, 12);
      const todayMidnight = new Date(2026, 5, 15);
      const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      for (const weeks of [1, 2, 4, 6, 8, 20]) {
        const end = new Date(todayMidnight.getTime() + weeks * 7 * 86400e3);
        const expected = {};
        let noDate = 0;
        for (const h of horses) {
          const next = FHH.build(h, appointments, invoices, now).nextService;
          if (!next) { noDate++; continue; }
          if (!(next.date < end)) continue;
          const owner = customers.find(c => c.id === h.customerId)?.name || h.customerName;
          expected[h.name + '|' + owner + '|' + h.id] = { date: fmt(next.date), status: !next.estimated ? 'booked' : next.overdue ? 'overdue' : 'due' };
        }
        const got = getHorsesDue({ horses, appointments, invoices, customers }, { today, tz: 'America/New_York' }, { weeks });
        const gotAll = getHorsesDue({ horses, appointments, invoices, customers }, { today, tz: 'America/New_York' }, { weeks });
        assert.equal(gotAll.horses_due, Object.keys(expected).length, `seed ${seed}, ${weeks} weeks: how many are due`);
        assert.equal(got.horses_with_no_due_date, noDate, `seed ${seed}, ${weeks} weeks: horses with no due date`);
        // Same horses, same dates, same status (rows are capped at 40, so compare the shown rows against the reference).
        const shown = got.horses.map(r => `${r.horse}|${r.owner}|${r.due_date}|${r.status}`).sort();
        const wantAll = Object.entries(expected).map(([k, v]) => `${k.split('|').slice(0, 2).join('|')}|${v.date}|${v.status}`).sort();
        if (got.horses_due <= 40) assert.deepEqual(shown, wantAll, `seed ${seed}, ${weeks} weeks: the horses and dates`);
        else for (const row of shown) assert.ok(wantAll.includes(row), `seed ${seed}, ${weeks} weeks: shown row ${row} is in the reference`);
        assert.equal(got.overdue, Object.values(expected).filter(v => v.status === 'overdue').length, `seed ${seed}, ${weeks} weeks: overdue`);
        assert.equal(got.already_booked, Object.values(expected).filter(v => v.status === 'booked').length, `seed ${seed}, ${weeks} weeks: booked`);
      }
    }
  } finally { if (savedTZ === undefined) delete process.env.TZ; else process.env.TZ = savedTZ; }
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

test('askAI: "horses due in the next 4 weeks" loads what the tool needs and returns the numbers behind the answer', async () => {
  const loaded = [];
  const client = fakeClient([toolUse('get_horses_due', { weeks: 4 }), say('5 horses are due in the next 4 weeks.')]);
  const out = await askAI({ caller: { uid: 'u-due', idToken: 't' }, biz, body: { question: 'How many horses are due in the next 4 weeks?', timezone: TZ } },
    { client, now, load: async (n) => { loaded.push(n); return dueData[n] || []; } });
  assert.deepEqual([...loaded].sort(), ['appointments', 'customers', 'horses', 'invoices']);
  assert.equal(out.facts[0].tool, 'get_horses_due');
  assert.equal(out.facts[0].result.horses_due, 5);
  assert.match(client.calls[0].system, /get_horses_due/);
  assert.ok(client.calls[0].tools.some(t => t.name === 'get_horses_due' && t.input_schema.required.includes('weeks')));
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
