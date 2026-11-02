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
  const horses = new Set();
  let invoicesInRange = 0, linesWithoutHorse = 0;
  for (const inv of invoices) {
    if (!live(inv)) continue;
    const d = localDate(inv.createdAt, tz);
    if (!d || d < from || d > to) continue;
    invoicesInRange++;
    for (const item of (Array.isArray(inv.items) ? inv.items : [])) {
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
    horses_serviced: horses.size,
    invoices_in_range: invoicesInRange,
    by_service: [...byService.entries()].map(([service, set]) => ({ service, horses: set.size }))
      .sort((a, b) => b.horses - a.horses || a.service.localeCompare(b.service)).slice(0, 40),
    lines_without_a_horse: linesWithoutHorse,
    basis: 'Distinct horses on non-cancelled invoices dated in the range (by invoice date). A horse on two invoices counts once; "by_service" counts a horse once per service line it had. Work that was never invoiced is not counted.',
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
];

export const toolDefinitions = () => TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
