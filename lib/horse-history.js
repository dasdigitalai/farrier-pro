// Horse history — everything on file for one horse, shared by index.html (desktop "Horses"
// tab) and mobile.html (horse detail screen), so both show the same dates.
//
// Plain script, like lib/pricing.js: pages load it with <script src="/lib/horse-history.js">
// and call window.FarriHorseHistory.build(horse, appointments, invoices). It only reads
// docs the page already loaded; it writes nothing.
//
// Which records belong to a horse:
//   - appointments: horseIds / horseRequests[].horseId hold its id, or (older bookings and
//     QR bookings, which have no horseId) a horseRequests[].horseName matches its name on
//     the same customer.
//   - invoices: a line item's horseId is its id, or a line with no horseId has its name on
//     the same customer.
//
// Last service: the latest of a past non-cancelled appointment, an invoice line for the
// horse, or horse.lastServiceDate (set when an invoice is saved). Next service: the soonest
// upcoming non-cancelled appointment; failing that, last service + shoeingCycleWeeks, marked
// as estimated.
(function (root) {
  const DAY = 86400e3;
  const norm = (s) => String(s || '').trim().toLowerCase();

  function toDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
    // 'YYYY-MM-DD' is read as local midnight, not UTC (new Date('2026-01-05') is the 4th in the US).
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const [y, m, d] = v.split('-').map(Number);
      return new Date(y, m - 1, d);
    }
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }

  function sameCustomer(horse, doc) {
    if (horse.customerId && doc.customerId) return horse.customerId === doc.customerId;
    return !!horse.customerName && norm(horse.customerName) === norm(doc.customerName);
  }

  // The services this appointment booked for this horse, or null if it isn't the horse's.
  function apptServicesFor(horse, a) {
    const reqs = Array.isArray(a.horseRequests) ? a.horseRequests : [];
    const byId = reqs.find(r => r.horseId && r.horseId === horse.id);
    if (byId) return byId.services || [];
    if ((a.horseIds || []).includes(horse.id)) return a.services || [];
    const name = norm(horse.name);
    if (!name || !sameCustomer(horse, a)) return null;
    const byName = reqs.find(r => !r.horseId && norm(r.horseName) === name);
    return byName ? (byName.services || []) : null;
  }

  // This invoice's line items for this horse (empty if none).
  function invoiceLinesFor(horse, inv) {
    const name = norm(horse.name);
    const nameOk = name && sameCustomer(horse, inv);
    return (inv.items || []).filter(i =>
      i.horseId ? i.horseId === horse.id : (nameOk && norm(i.horseName) === name));
  }

  function build(horse, appointments, invoices, now) {
    now = now || new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const appts = [];
    (appointments || []).forEach(a => {
      const services = apptServicesFor(horse, a);
      if (services === null) return;
      appts.push({ ...a, horseServices: services, date: toDate(a.requestedDate || a.date) });
    });
    appts.sort((x, y) => (y.date || 0) - (x.date || 0));

    const invs = [];
    (invoices || []).forEach(inv => {
      const lines = invoiceLinesFor(horse, inv);
      if (!lines.length) return;
      const horseTotal = lines.reduce((s, i) => s + (Number(i.amount) || 0), 0); // amount is already the line total
      invs.push({ ...inv, horseLines: lines, horseTotal, date: toDate(inv.createdAt) });
    });
    invs.sort((x, y) => (y.date || 0) - (x.date || 0));

    const live = appts.filter(a => a.date && a.status !== 'cancelled');
    const past = live.filter(a => a.date < today);
    const upcoming = live.filter(a => a.date >= today).sort((x, y) => x.date - y.date);

    const candidates = [];
    if (past[0]) candidates.push({ date: past[0].date, label: (past[0].horseServices || []).join(', ') });
    if (invs[0] && invs[0].date) candidates.push({ date: invs[0].date, label: invs[0].horseLines.map(l => l.description).filter(Boolean).join(', ') });
    const stamped = toDate(horse.lastServiceDate);
    if (stamped) candidates.push({ date: stamped, label: horse.lastServiceName || '' });
    candidates.sort((x, y) => y.date - x.date);
    const lastService = candidates[0] || null;

    let nextService = null;
    if (upcoming[0]) {
      nextService = { date: upcoming[0].date, label: (upcoming[0].horseServices || []).join(', '), estimated: false, appointment: upcoming[0] };
    } else if (lastService && Number(horse.shoeingCycleWeeks) > 0) {
      const due = new Date(lastService.date.getTime() + Number(horse.shoeingCycleWeeks) * 7 * DAY);
      nextService = { date: due, label: `Due — every ${horse.shoeingCycleWeeks} weeks`, estimated: true, overdue: due < today };
    }

    const totalBilled = invs.reduce((s, i) => s + i.horseTotal, 0);
    return { appointments: appts, invoices: invs, upcoming, lastService, nextService, totalBilled };
  }

  root.FarriHorseHistory = { build, toDate };
})(typeof window !== 'undefined' ? window : globalThis);
