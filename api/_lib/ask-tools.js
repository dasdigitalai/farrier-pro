// "Ask FarriTech" — the numbers behind the AI assistant (see ask-ai.js).
//
// The AI never does arithmetic or reads records itself. It picks one of the tools below and
// fills in a date range; plain code here does the counting and adding from the farrier's own
// invoices / customers / appointments, and hands back small summaries. Every figure in an
// answer therefore comes from this file, not from the model.
//
// Pure functions: they take already-loaded records and never touch Firestore or the network,
// so they are easy to test (scripts/ask-ai.test.mjs).
//
// Money: an invoice's open balance is FarriPricing.balanceCents — at the cash price, the same
// number the Business Dashboard calls "owed".
// Dates: all comparisons use the business's local calendar day (timezone), as YYYY-MM-DD.
import '../../lib/pricing.js';

const P = globalThis.FarriPricing;
const DAY = 86400e3;

export class ToolInputError extends Error {}

// ── Dates ──
export function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'America/New_York'; }
}

// A Firestore timestamp (ISO string from the REST API), a Date, or an already-plain
// 'YYYY-MM-DD' → that calendar day in `tz`, as 'YYYY-MM-DD'. null if it isn't a date.
export function localDate(v, tz) {
  if (!v) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const utc = (s) => new Date(s + 'T00:00:00Z');
export const addDays = (s, n) => new Date(utc(s).getTime() + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / DAY);

// Named ranges handed to the model so it never does calendar math. Weeks run Monday–Sunday.
export function namedRanges(today) {
  const mondayOffset = (utc(today).getUTCDay() + 6) % 7;
  const weekStart = addDays(today, -mondayOffset);
  const lastWeekStart = addDays(weekStart, -7);
  const monthStart = today.slice(0, 8) + '01';
  const nextMonthStart = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7), 1)).toISOString().slice(0, 10);
  const lastMonthEnd = addDays(monthStart, -1);
  return {
    'today': [today, today],
    'this week (Mon–Sun)': [weekStart, addDays(weekStart, 6)],
    'last week (Mon–Sun)': [lastWeekStart, addDays(lastWeekStart, 6)],
    'this month': [monthStart, addDays(nextMonthStart, -1)],
    'last month': [lastMonthEnd.slice(0, 8) + '01', lastMonthEnd],
    'last 7 days': [addDays(today, -6), today],
    'last 30 days': [addDays(today, -29), today],
    'this year': [today.slice(0, 4) + '-01-01', today.slice(0, 4) + '-12-31'],
  };
}

function checkDate(s, label) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(utc(s)) || utc(s).toISOString().slice(0, 10) !== s) {
    throw new ToolInputError(`${label} must be a real date written YYYY-MM-DD.`);
  }
  return s;
}
function checkRange(from, to) {
  checkDate(from, 'from'); checkDate(to, 'to');
  if (from > to) throw new ToolInputError('from must not be after to.');
  return [from, to];
}

// ── Small helpers ──
const norm = (s) => String(s || '').trim().toLowerCase();
const dollars = (cents) => Math.round(cents) / 100;
const live = (inv) => inv && inv.status !== 'cancelled';
// The same customer across records: by id when both have one, else by name.
const custKey = (doc) => doc.customerId ? 'id:' + doc.customerId : 'name:' + norm(doc.customerName);

// ── Tool: money owed ──
function summarizeOwed(rows, { withCustomers }) {
  const out = { total_owed: dollars(rows.reduce((s, r) => s + r.cents, 0)), unpaid_invoices: rows.length };
  const byCustomer = new Map();
  for (const r of rows) {
    const c = byCustomer.get(r.key) || { customer: r.name, owed: 0, invoices: 0, oldest_invoice_days: 0 };
    c.owed += r.cents; c.invoices++; c.oldest_invoice_days = Math.max(c.oldest_invoice_days, r.age ?? 0);
    byCustomer.set(r.key, c);
  }
  out.customers_owing = byCustomer.size;
  if (withCustomers) {
    const list = [...byCustomer.values()].sort((a, b) => b.owed - a.owed).map(c => ({ ...c, owed: dollars(c.owed) }));
    out.customers = list.slice(0, 25);
    if (list.length > 25) out.customers_not_shown = list.length - 25;
  }
  return out;
}

export function getMoneyOwed({ invoices }, { today, tz }, input = {}) {
  const hasFrom = input.from != null, hasTo = input.to != null;
  if (hasFrom !== hasTo) throw new ToolInputError('Give both from and to, or neither.');
  const range = hasFrom ? checkRange(input.from, input.to) : null;

  const rows = [];
  for (const inv of invoices) {
    if (inv.status !== 'outstanding' && inv.status !== 'partial') continue;
    const cents = P.balanceCents(inv);
    if (cents <= 0) continue;
    const date = localDate(inv.createdAt, tz);
    rows.push({ cents, date, age: date ? daysBetween(date, today) : null, key: custKey(inv), name: inv.customerName || 'Unknown customer' });
  }
  const result = {
    as_of: today,
    basis: 'Unpaid and part-paid invoices, remaining balance at the cash price. Cancelled invoices are excluded.',
  };
  if (range) {
    result.all_time = summarizeOwed(rows, { withCustomers: false });
    result.invoiced_in_range = {
      from: range[0], to: range[1],
      ...summarizeOwed(rows.filter(r => r.date && r.date >= range[0] && r.date <= range[1]), { withCustomers: true }),
    };
  } else {
    result.all_time = summarizeOwed(rows, { withCustomers: true });
  }
  return result;
}

// ── Tool: customers ──
export function countCustomers({ customers, invoices, appointments }, { today, tz }, input = {}) {
  let days = input.active_within_days ?? 180;
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new ToolInputError('active_within_days must be a whole number from 1 to 3650.');
  const cutoff = addDays(today, -days);

  const activeKeys = new Set();
  for (const inv of invoices) {
    const d = localDate(inv.createdAt, tz);
    if (live(inv) && d && d >= cutoff) activeKeys.add(custKey(inv));
  }
  for (const a of appointments) {
    const d = localDate(a.requestedDate || a.date, tz);
    if (a.status !== 'cancelled' && d && d >= cutoff) activeKeys.add(custKey(a));
  }
  let active = 0;
  for (const c of customers) {
    // A customer doc matches by its own id, or by name for records that never stored an id.
    if (activeKeys.has('id:' + c.id) || activeKeys.has('name:' + norm(c.name))) active++;
  }
  return {
    as_of: today,
    total_customers: customers.length,
    active_customers: active,
    not_active: customers.length - active,
    active_within_days: days,
    active_definition: `A customer is active if they have an invoice or a non-cancelled appointment dated within the last ${days} days (since ${cutoff}). FarriTech has no separate "active" flag on customers.`,
  };
}

// ── Tool: horses worked on ──
export function countHorsesServiced({ invoices }, { tz }, input = {}) {
  const [from, to] = checkRange(input.from, input.to);
  const byService = new Map();
  const unnamedByService = new Map(); // "Multiple horses" lines: qty horses nobody named, so they can't be de-duplicated
  const horses = new Set();
  let invoicesInRange = 0, linesWithoutHorse = 0, unnamed = 0;
  for (const inv of invoices) {
    if (!live(inv)) continue;
    const d = localDate(inv.createdAt, tz);
    if (!d || d < from || d > to) continue;
    invoicesInRange++;
    for (const item of (Array.isArray(inv.items) ? inv.items : [])) {
      if (!item.horseId && item.horseName === P.MULTIPLE_HORSES) {
        // One line covering several horses the farrier didn't name (a polo string, a barn): qty horses.
        const qty = P.itemQty(item), svc = String(item.description || item.name || '').trim() || 'Other';
        unnamed += qty; unnamedByService.set(svc, (unnamedByService.get(svc) || 0) + qty);
        continue;
      }
      const horseKey = item.horseId ? 'id:' + item.horseId
        : item.horseName ? 'name:' + (inv.customerId || norm(inv.customerName)) + ':' + norm(item.horseName) : null;
      if (!horseKey) { linesWithoutHorse++; continue; }
      horses.add(horseKey);
      const service = String(item.description || item.name || '').trim() || 'Other';
      const set = byService.get(service) || new Set();
      set.add(horseKey); byService.set(service, set);
    }
  }
  return {
    from, to,
    horses_serviced: horses.size + unnamed,
    horses_in_multi_horse_lines: unnamed,
    invoices_in_range: invoicesInRange,
    by_service: [...new Set([...byService.keys(), ...unnamedByService.keys()])]
      .map(service => ({ service, horses: (byService.get(service)?.size || 0) + (unnamedByService.get(service) || 0) }))
      .sort((a, b) => b.horses - a.horses || a.service.localeCompare(b.service)).slice(0, 40),
    lines_without_a_horse: linesWithoutHorse,
    basis: 'Distinct horses on non-cancelled invoices dated in the range (by invoice date). A named horse on two invoices counts once; "by_service" counts a horse once per service. Lines billed as "Multiple horses" count their quantity (those horses have no names, so they cannot be matched to each other). Work that was never invoiced is not counted.',
  };
}

// ── Tool: find customers / farms by place or name ──
// Matches partial text, case-insensitively, on the customer's city, ZIP, street address (a
// state only by its exact code), and on name or farm name. Phone and email are never returned.
export function findCustomers({ customers }, ctx, input = {}) {
  const place = norm(input.place), name = norm(input.name);
  if (!place && !name) throw new ToolInputError('Give a place (city, ZIP or street) and/or a name or farm name to search for.');
  if (place.length > 60 || name.length > 60) throw new ToolInputError('Search text is too long.');
  const rows = customers.filter(c => {
    if (name && !(norm(c.name).includes(name) || norm(c.farmName).includes(name))) return false;
    if (place && !(norm(c.city).includes(place) || norm(c.zip).includes(place) || norm(c.address).includes(place) || norm(c.state) === place)) return false;
    return true;
  }).map(c => ({ customer: c.name || 'Unknown', farm: c.farmName || '', city: c.city || '', address: c.address || '' }))
    .sort((a, b) => (a.farm || a.customer).localeCompare(b.farm || b.customer));
  return {
    searched: { place: input.place || '', name: input.name || '' },
    matches: rows.length,
    with_a_farm_name: rows.filter(r => r.farm).length,
    customers: rows.slice(0, 40),
    ...(rows.length > 40 ? { not_shown: rows.length - 40 } : {}),
    basis: 'Customer records whose city, ZIP or street address contains the place, and/or whose name or farm name contains the name. A customer with no address on file will not match a place search.',
  };
}

// ── Tool: one horse's history ──
export function findHorse({ invoices, horses }, { tz }, input = {}) {
  const q = norm(input.name);
  if (q.length < 2 || q.length > 60) throw new ToolInputError('name must be 2 to 60 characters.');
  const exactDocs = horses.filter(h => norm(h.name) === q);
  const docs = exactDocs.length ? exactDocs : horses.filter(h => norm(h.name).includes(q));
  const docById = new Map(docs.map(h => [h.id, h]));
  // If a horse is on file under exactly this name, "Bonnie Blue" is someone else's horse; otherwise match loosely.
  const nameMatch = (n) => { n = norm(n); return exactDocs.length ? n === q : (n === q || n.includes(q)); };

  const groups = new Map();
  for (const inv of invoices) {
    if (!live(inv)) continue;
    const date = localDate(inv.createdAt, tz);
    if (!date) continue;
    for (const item of (Array.isArray(inv.items) ? inv.items : [])) {
      if (!item.horseId && item.horseName === P.MULTIPLE_HORSES) continue;
      if (!(docById.has(item.horseId) || nameMatch(item.horseName))) continue;
      const key = item.horseId || 'name:' + custKey(inv) + ':' + norm(item.horseName);
      const doc = docById.get(item.horseId);
      const g = groups.get(key) || { horse: doc?.name || item.horseName, customer: doc?.customerName || inv.customerName || '', invoiceIds: new Set(), services: new Map(), visits: new Map() };
      const service = String(item.description || item.name || '').trim() || 'Other';
      g.invoiceIds.add(inv.id);
      g.services.set(service, (g.services.get(service) || 0) + 1);
      const v = g.visits.get(date) || new Set(); v.add(service); g.visits.set(date, v);
      groups.set(key, g);
    }
  }
  const out = [];
  for (const [key, g] of groups) {
    const dates = [...g.visits.keys()].sort();
    out.push({
      horse: g.horse, customer: g.customer,
      invoices: g.invoiceIds.size,
      first_invoiced: dates[0], last_invoiced: dates.at(-1),
      services: [...g.services.entries()].map(([service, times]) => ({ service, times })).sort((a, b) => b.times - a.times || a.service.localeCompare(b.service)),
      recent_visits: dates.slice(-5).reverse().map(d => ({ date: d, services: [...g.visits.get(d)].join(', ') })),
      on_file_as_a_horse: docById.has(key),
    });
  }
  // Horses on file under this name that were never invoiced.
  for (const h of docs) {
    if (groups.has(h.id)) continue;
    out.push({ horse: h.name, customer: h.customerName || '', invoices: 0, on_file_as_a_horse: true, last_service_recorded_on_horse: localDate(h.lastServiceDate, tz) || 'none',
      note: 'On file, but on no invoice.' });
  }
  out.sort((a, b) => (b.last_invoiced || '').localeCompare(a.last_invoiced || ''));
  return {
    searched_for: String(input.name).trim(),
    horses_found: out.length,
    horses: out.slice(0, 10),
    ...(out.length > 10 ? { horses_not_shown: out.length - 10 } : {}),
    basis: 'Invoice lines for this horse name on non-cancelled invoices (dates are invoice dates), plus horses on file with that name. Work that was never invoiced is not included.',
  };
}

// ── Tool: money collected ──
// Same rules as the Business Dashboard (lib/owner-dashboard.js): "collected" is what came in,
// counted on the day each payment was made (card price included), cancelled invoices left out,
// refunds reported separately. Invoices from before payments[] was kept count their paidAmount
// (or total) once, on paidAt.
const METHOD_LABELS = { card: 'Card', cash: 'Cash', check: 'Check', other: 'Zelle, Venmo & other' };
function methodKind(method) {
  const m = String(method || '').toLowerCase();
  if (/card|credit|stripe|ipos|tap/.test(m)) return 'card';
  if (m === 'cash') return 'cash';
  if (m === 'check') return 'check';
  return 'other';
}
const toCents = (dollars) => Math.round((Number(dollars) || 0) * 100);

function paymentsOf(inv) {
  const list = Array.isArray(inv.payments) ? inv.payments : [];
  if (list.length) return list.map(p => ({ cents: toCents(p.amount), date: p.date || inv.paidAt || inv.createdAt, kind: methodKind(p.method) }));
  if (inv.status === 'paid' && (inv.paidAmount || inv.total)) {
    return [{ cents: toCents(inv.paidAmount || inv.total), date: inv.paidAt || inv.createdAt, kind: methodKind(inv.paymentMethod) }];
  }
  return [];
}

export function getMoneyCollected({ invoices }, { tz }, input = {}) {
  const [from, to] = checkRange(input.from, input.to);
  const inRange = (v) => { const d = localDate(v, tz); return !!d && d >= from && d <= to; };
  let collected = 0, paymentCount = 0, refunds = 0, invoiced = 0, invoicedCount = 0;
  const byKind = { card: 0, cash: 0, check: 0, other: 0 };
  for (const inv of invoices) {
    if (!live(inv)) continue;
    for (const p of paymentsOf(inv)) {
      if (p.cents <= 0 || !inRange(p.date)) continue;
      collected += p.cents; paymentCount++; byKind[p.kind] += p.cents;
    }
    for (const r of (Array.isArray(inv.refunds) ? inv.refunds : [])) if (inRange(r.date)) refunds += toCents(r.amount);
    if (inRange(inv.createdAt)) { invoiced += toCents(inv.total); invoicedCount++; }
  }
  return {
    from, to,
    total_collected: dollars(collected),
    payments: paymentCount,
    refunds: dollars(refunds),
    collected_after_refunds: dollars(collected - refunds),
    by_method: Object.entries(byKind).filter(([, c]) => c > 0).map(([k, c]) => ({ method: METHOD_LABELS[k], collected: dollars(c) })),
    for_comparison_invoiced_in_range: dollars(invoiced),
    invoices_created_in_range: invoicedCount,
    basis: 'Money received, counted on the day each payment was made (card payments include the card price). Cancelled invoices are excluded. Refunds are shown separately. "Invoiced" is what was billed in the range, paid or not, so it can differ from what was collected.',
  };
}

// ── Tool: invoice size ──
export function getInvoiceStats({ invoices }, { tz }, input = {}) {
  const hasFrom = input.from != null, hasTo = input.to != null;
  if (hasFrom !== hasTo) throw new ToolInputError('Give both from and to, or neither (neither means all time).');
  const range = hasFrom ? checkRange(input.from, input.to) : null;
  const cents = invoices
    .filter(inv => live(inv) && (!range || (() => { const d = localDate(inv.createdAt, tz); return !!d && d >= range[0] && d <= range[1]; })()))
    .map(inv => toCents(inv.total)).sort((a, b) => a - b);
  const n = cents.length, total = cents.reduce((s, c) => s + c, 0);
  const median = n === 0 ? null : n % 2 ? cents[(n - 1) / 2] : (cents[n / 2 - 1] + cents[n / 2]) / 2;
  return {
    period: range ? { from: range[0], to: range[1] } : 'all time',
    invoices: n,
    total_invoiced: dollars(total),
    average_invoice: n ? dollars(total / n) : null,
    median_invoice: n ? dollars(median) : null,
    largest_invoice: n ? dollars(cents[n - 1]) : null,
    smallest_invoice: n ? dollars(cents[0]) : null,
    basis: 'Invoice totals for non-cancelled invoices dated in the period (paid or not). The average is the total divided by the number of invoices; the median is the middle invoice, which big jobs do not skew.',
  };
}

// ── What the model sees ──
export const TOOLS = [
  {
    name: 'get_money_owed',
    description: 'Who owes the farrier money: unpaid and part-paid invoices, with each customer\'s balance and how old their oldest unpaid invoice is. ' +
      'Without from/to it covers everything unpaid. With from/to it lists the customers whose unpaid invoices are DATED in that range (and still reports the all-time total). ' +
      'For "who owes me money this week" pass this week\'s range.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First invoice date to include, YYYY-MM-DD. Only with `to`.' },
        to: { type: 'string', description: 'Last invoice date to include, YYYY-MM-DD. Only with `from`.' },
      },
    },
    needs: ['invoices'],
    run: getMoneyOwed,
  },
  {
    name: 'count_customers',
    description: 'How many customers the farrier has: the total, and how many are active. "Active" = an invoice or non-cancelled appointment within the last N days (default 180). ' +
      'Always tell the user the definition you used.',
    input_schema: {
      type: 'object',
      properties: { active_within_days: { type: 'integer', description: 'Look-back window in days. Default 180.' } },
    },
    needs: ['customers', 'invoices', 'appointments'],
    run: countCustomers,
  },
  {
    name: 'count_horses_serviced',
    description: 'How many different horses were worked on (invoiced) between two dates, with a breakdown by service (e.g. full set, trim, reset). ' +
      'The breakdown is how to answer "how many did I shoe": add up only the shoeing-type services and say which ones you counted.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First day, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Last day, YYYY-MM-DD.' },
      },
      required: ['from', 'to'],
    },
    needs: ['invoices'],
    run: countHorsesServiced,
  },
  {
    name: 'get_invoice_stats',
    description: 'How big the farrier\'s invoices are: count, total invoiced, average, median, largest and smallest invoice, for a period or (with no from/to) all time. ' +
      'Use for "what is my average invoice". This is what was billed, whether or not it was paid.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First invoice date, YYYY-MM-DD. Only with `to`; omit both for all time.' },
        to: { type: 'string', description: 'Last invoice date, YYYY-MM-DD. Only with `from`.' },
      },
    },
    needs: ['invoices'],
    run: getInvoiceStats,
  },
  {
    name: 'find_customers',
    description: 'Find customers or farms by place (city, ZIP, street) and/or by name or farm name. Use for "what farms do I have in Loxahatchee", "who do I have on Southern Blvd", "do I have a customer named Smith". ' +
      'Partial text works; if nothing matches, try a shorter piece of the place name. Returns name, farm name, city and street address (never phone or email).',
    input_schema: {
      type: 'object',
      properties: {
        place: { type: 'string', description: 'City, ZIP or street text to look for, e.g. "Loxahatchee".' },
        name: { type: 'string', description: 'Part of a customer name or farm name.' },
      },
    },
    needs: ['customers'],
    run: findCustomers,
  },
  {
    name: 'find_horse',
    description: 'Look up one horse by name: whether it is on file, who owns it, which services it has had, how many times, and the dates of the first, last and recent visits. ' +
      'Use for "did I ever shoe a horse named Bonnie", "when did I last do Rex". Several horses can share a name (different owners): each is listed. ' +
      'To say whether a horse was SHOD, look at the service names (full set, reset, etc.) and say which you counted.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The horse\'s name, e.g. "Bonnie". Partial names work.' } },
      required: ['name'],
    },
    needs: ['invoices', 'horses'],
    run: findHorse,
  },
  {
    name: 'get_money_collected',
    description: 'How much money the farrier actually collected (payments received) between two dates, with a breakdown by payment method (card, cash, check, other), refunds, ' +
      'and for comparison how much was invoiced in the same period. Use for "how much did I collect / get paid / take in". ' +
      'This is payments by the day they were made, not invoices by invoice date.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First day, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Last day, YYYY-MM-DD.' },
      },
      required: ['from', 'to'],
    },
    needs: ['invoices'],
    run: getMoneyCollected,
  },
];

export const toolDefinitions = () => TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
