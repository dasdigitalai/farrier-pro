// Owner dashboard — the business at a glance, shared by index.html (desktop "Business" tab)
// and mobile.html ("Business Dashboard" screen), so both show the same numbers.
//
// Plain script, like lib/pricing.js: pages load it with <script src="/lib/owner-dashboard.js">
// and use window.FarriOwnerDash.compute(...) then .render(element, stats, { dark }).
// It only reads invoices and appointments the page already loaded; it writes nothing.
//
// Money: "collected" is what came in (payments on invoices, by payment date, card price
// included), minus nothing; refunds are shown on their own. "Owed" is the open balance at the
// cash price (FarriPricing.balanceCents). All math in integer cents.
//
// Colors: categorical slots 1–4 of the dataviz reference palette, validated for this app's
// light (mobile, white) and dark (desktop, #162032) surfaces. Light slots 3–4 sit under 3:1
// contrast, so every mark is also labeled with its value (no color-only reading).
(function (root) {
  const P = root.FarriPricing;
  const DAY = 86400e3;
  const cents = (d) => Math.round((Number(d) || 0) * 100);
  const money = (c) => '$' + ((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const moneyShort = (c) => {
    const d = (c || 0) / 100;
    return d >= 10000 ? '$' + (d / 1000).toFixed(d >= 100000 ? 0 : 1) + 'k' : '$' + Math.round(d).toLocaleString('en-US');
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function toDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }
  const monthKey = (d) => `${d.getFullYear()}-${d.getMonth()}`;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Payments on an invoice as [{ cents, date, kind }]. Invoices from before payments[] was kept
  // count their paidAmount once, on paidAt.
  function paymentsOf(inv) {
    const list = Array.isArray(inv.payments) ? inv.payments : [];
    if (list.length) {
      return list.map(p => ({ cents: cents(p.amount), date: toDate(p.date) || toDate(inv.paidAt) || toDate(inv.createdAt), kind: kindOf(p.method) }));
    }
    if (inv.status === 'paid' && (inv.paidAmount || inv.total)) {
      return [{ cents: cents(inv.paidAmount || inv.total), date: toDate(inv.paidAt) || toDate(inv.createdAt), kind: kindOf(inv.paymentMethod) }];
    }
    return [];
  }
  function kindOf(method) {
    const m = String(method || '').toLowerCase();
    if (/card|credit|stripe|ipos|tap/.test(m)) return 'card';
    if (m === 'cash') return 'cash';
    if (m === 'check') return 'check';
    return 'other';
  }
  const KINDS = [['card', 'Card'], ['cash', 'Cash'], ['check', 'Check'], ['other', 'Zelle, Venmo & other']];

  // invoices / appointments: arrays of Firestore docs ({ id, ...data }).
  // names: { uid: 'Display name' } for team members (optional); ownerId: the business id.
  function compute(invoices, appointments, { names = {}, ownerId = '', now = new Date() } = {}) {
    invoices = (invoices || []).filter(i => i && i.status !== 'cancelled');
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    // Same point last month, for a fair month-to-date comparison.
    const lastMonthSameDay = new Date(lastMonthStart.getFullYear(), lastMonthStart.getMonth(),
      Math.min(now.getDate(), new Date(now.getFullYear(), now.getMonth(), 0).getDate()), now.getHours(), now.getMinutes());
    const d90 = new Date(now - 90 * DAY);

    let collectedMTD = 0, collectedLastMTD = 0, refundsMTD = 0, invoicedMTD = 0, invoiceCountMTD = 0;
    const byMonth = {};
    const mix = { card: 0, cash: 0, check: 0, other: 0 };
    const services = {};
    const aging = [0, 0, 0, 0]; // 0–30, 31–60, 61–90, 90+ days
    let owed = 0, owedCount = 0, overdue = 0, overdueCount = 0;
    const owedBy = {};
    const team = {};

    for (const inv of invoices) {
      const created = toDate(inv.createdAt);
      const who = inv.performedBy || ownerId || '';
      const t = team[who] || (team[who] = { invoiced: 0, collected: 0, jobs: 0 });
      if (created && created >= monthStart) {
        invoicedMTD += cents(inv.total); invoiceCountMTD++;
        t.invoiced += cents(inv.total); t.jobs++;
      }
      for (const p of paymentsOf(inv)) {
        if (!p.date || p.cents <= 0) continue;
        if (p.date >= monthStart) { collectedMTD += p.cents; t.collected += p.cents; }
        if (p.date >= lastMonthStart && p.date < lastMonthSameDay) collectedLastMTD += p.cents;
        byMonth[monthKey(p.date)] = (byMonth[monthKey(p.date)] || 0) + p.cents;
        if (p.date >= d90) mix[p.kind] += p.cents;
      }
      for (const r of (Array.isArray(inv.refunds) ? inv.refunds : [])) {
        const d = toDate(r.date);
        if (d && d >= monthStart) refundsMTD += cents(r.amount);
      }
      if (created && created >= d90) {
        for (const item of (inv.items || inv.lineItems || [])) {
          const name = String(item.description || item.name || '').trim() || 'Other';
          services[name] = (services[name] || 0) + cents(item.amount ?? item.price ?? item.unitPrice);
        }
      }
      if (inv.status === 'outstanding' || inv.status === 'partial') {
        const bal = P ? P.balanceCents(inv) : Math.max(0, cents(inv.total) - cents(inv.paidAmount));
        if (bal > 0) {
          owed += bal; owedCount++;
          const age = created ? Math.floor((now - created) / DAY) : 0;
          aging[age > 90 ? 3 : age > 60 ? 2 : age > 30 ? 1 : 0] += bal;
          if (age > 30) { overdue += bal; overdueCount++; }
          const cust = inv.customerName || 'Unknown customer';
          const o = owedBy[cust] || (owedBy[cust] = { cents: 0, count: 0, oldest: 0 });
          o.cents += bal; o.count++; o.oldest = Math.max(o.oldest, age);
        }
      }
    }

    const months = [];
    for (let k = 5; k >= 0; k--) {
      const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
      months.push({ label: MONTHS[d.getMonth()], year: d.getFullYear(), cents: byMonth[monthKey(d)] || 0, current: k === 0 });
    }

    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const in7 = new Date(today.getTime() + 7 * DAY);
    const upcoming = (appointments || []).filter(a => {
      if (!a || a.status === 'cancelled' || a.status === 'completed') return false;
      const d = a.requestedDate ? new Date(a.requestedDate + 'T12:00:00') : toDate(a.date);
      return d && d >= today && d < in7;
    }).length;

    const teamRows = Object.entries(team)
      .filter(([, v]) => v.invoiced || v.collected)
      .map(([uid, v]) => ({ name: names[uid] || (uid === ownerId ? 'Owner' : 'Former team member'), ...v }))
      .sort((a, b) => b.collected - a.collected || b.invoiced - a.invoiced);

    return {
      asOf: now,
      collectedMTD, collectedLastMTD, refundsMTD, invoicedMTD, invoiceCountMTD,
      avgInvoiceMTD: invoiceCountMTD ? Math.round(invoicedMTD / invoiceCountMTD) : 0,
      owed, owedCount, overdue, overdueCount, upcoming,
      months, aging,
      mix: KINDS.map(([k, label]) => ({ key: k, label, cents: mix[k] })),
      topServices: Object.entries(services).map(([name, c]) => ({ name, cents: c })).filter(s => s.cents > 0)
        .sort((a, b) => b.cents - a.cents).slice(0, 5),
      topOwed: Object.entries(owedBy).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.cents - a.cents).slice(0, 5),
      team: teamRows.length > 1 ? teamRows : [],
    };
  }

  const CSS = `
.odb { --odb-s1:#2a78d6; --odb-s2:#eb6834; --odb-s3:#1baf7a; --odb-s4:#eda100; --odb-bar:#2a78d6; --odb-track:rgba(13,19,32,.07);
  --odb-good:#15803d; --odb-bad:#b91c1c; --odb-ink:var(--text,#0D1320); --odb-muted:var(--text-muted,#5A6A7E);
  --odb-card:var(--surface,#fff); --odb-line:var(--border,#DDE3EC); color:var(--odb-ink); font-variant-numeric:tabular-nums; }
.odb.odb-dark { --odb-s1:#3987e5; --odb-s2:#d95926; --odb-s3:#199e70; --odb-s4:#c98500; --odb-bar:#3987e5; --odb-track:rgba(232,240,254,.08);
  --odb-good:#4ade80; --odb-bad:#f87171; }
.odb-tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-bottom:12px; }
.odb-tile, .odb-card { background:var(--odb-card); border:1px solid var(--odb-line); border-radius:12px; padding:14px; min-width:0; }
.odb-tile-label { font-size:.75rem; font-weight:600; color:var(--odb-muted); text-transform:uppercase; letter-spacing:.04em; }
.odb-tile-value { font-size:1.6rem; font-weight:800; margin-top:4px; line-height:1.15; overflow-wrap:anywhere; }
.odb-tile-sub { font-size:.78rem; color:var(--odb-muted); margin-top:4px; }
.odb-up { color:var(--odb-good); font-weight:700; } .odb-down { color:var(--odb-bad); font-weight:700; }
.odb-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr)); gap:12px; }
.odb-card h3 { margin:0 0 2px; font-size:1rem; } .odb-card .odb-note { font-size:.78rem; color:var(--odb-muted); margin:0 0 12px; }
.odb-cols { display:flex; align-items:flex-end; gap:8px; height:150px; padding-top:18px; }
.odb-col { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%; position:relative; min-width:0; }
.odb-col-bar { width:100%; max-width:44px; background:var(--odb-bar); border-radius:4px 4px 0 0; min-height:2px; opacity:.55; }
.odb-col.odb-now .odb-col-bar { opacity:1; }
.odb-col-val { font-size:.7rem; color:var(--odb-muted); margin-bottom:3px; white-space:nowrap; }
.odb-col-lab { font-size:.75rem; color:var(--odb-muted); margin-top:6px; }
.odb-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px 10px; align-items:center; margin-bottom:10px; }
.odb-row-name { font-size:.85rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.odb-row-val { font-size:.85rem; font-weight:700; text-align:right; }
.odb-track { grid-column:1 / -1; height:8px; background:var(--odb-track); border-radius:4px; overflow:hidden; }
.odb-fill { height:100%; background:var(--odb-bar); border-radius:4px; }
.odb-stack { display:flex; height:22px; border-radius:6px; overflow:hidden; gap:2px; margin-bottom:12px; background:var(--odb-card); }
.odb-stack > div { min-width:3px; }
.odb-legend { display:grid; gap:6px; }
.odb-legend > div { display:flex; align-items:center; gap:8px; font-size:.85rem; }
.odb-sw { width:12px; height:12px; border-radius:3px; flex-shrink:0; }
.odb-legend .odb-row-val { margin-left:auto; }
.odb-table { width:100%; border-collapse:collapse; font-size:.85rem; }
.odb-table th { text-align:left; font-size:.72rem; color:var(--odb-muted); text-transform:uppercase; letter-spacing:.04em; padding:0 6px 6px 0; font-weight:600; }
.odb-table td { padding:7px 6px 7px 0; border-top:1px solid var(--odb-line); }
.odb-table td.n, .odb-table th.n { text-align:right; }
.odb-empty { font-size:.85rem; color:var(--odb-muted); padding:8px 0; }
.odb [data-tip] { cursor:default; }
.odb-tip { position:fixed; z-index:9999; pointer-events:none; background:#0D1320; color:#fff; font-size:.78rem; padding:6px 9px; border-radius:6px;
  box-shadow:0 4px 14px rgba(0,0,0,.25); white-space:nowrap; transform:translate(-50%,-100%); margin-top:-8px; display:none; }
`;

  function render(el, s, { dark = false } = {}) {
    if (!el) return;
    if (!document.getElementById('odb-css')) {
      const st = document.createElement('style'); st.id = 'odb-css'; st.textContent = CSS; document.head.appendChild(st);
    }
    const change = s.collectedLastMTD > 0 ? Math.round((s.collectedMTD - s.collectedLastMTD) / s.collectedLastMTD * 100) : null;
    const tile = (label, value, sub = '') => `<div class="odb-tile"><div class="odb-tile-label">${label}</div><div class="odb-tile-value">${value}</div>${sub ? `<div class="odb-tile-sub">${sub}</div>` : ''}</div>`;
    const tiles = [
      tile('Collected this month', money(s.collectedMTD),
        change === null ? (s.collectedLastMTD === 0 && s.collectedMTD > 0 ? 'Nothing by this point last month' : '')
          : `<span class="${change >= 0 ? 'odb-up' : 'odb-down'}">${change >= 0 ? '▲' : '▼'} ${Math.abs(change)}%</span> vs ${money(s.collectedLastMTD)} same point last month`),
      tile('Owed to you', money(s.owed), `${s.owedCount} open invoice${s.owedCount === 1 ? '' : 's'}`),
      tile('Over 30 days', money(s.overdue), s.overdueCount ? `${s.overdueCount} invoice${s.overdueCount === 1 ? '' : 's'} to chase` : 'Nothing overdue'),
      tile('Invoiced this month', money(s.invoicedMTD), s.invoiceCountMTD ? `${s.invoiceCountMTD} invoice${s.invoiceCountMTD === 1 ? '' : 's'} · avg ${money(s.avgInvoiceMTD)}` : 'No invoices yet'),
      tile('Next 7 days', String(s.upcoming), `appointment${s.upcoming === 1 ? '' : 's'} booked`),
      tile('Refunds this month', money(s.refundsMTD)),
    ].join('');

    const maxM = Math.max(1, ...s.months.map(m => m.cents));
    const cols = s.months.map(m => `<div class="odb-col${m.current ? ' odb-now' : ''}" data-tip="${m.label} ${m.year}: ${money(m.cents)} collected${m.current ? ' so far' : ''}">
      <div class="odb-col-val">${m.cents ? moneyShort(m.cents) : ''}</div>
      <div class="odb-col-bar" style="height:${Math.max(1, m.cents / maxM * 100)}%"></div>
      <div class="odb-col-lab">${m.label}</div></div>`).join('');

    const bars = (rows, fmt, tip) => {
      const max = Math.max(1, ...rows.map(r => r.cents));
      return rows.map(r => `<div class="odb-row" data-tip="${esc(tip(r))}"><div class="odb-row-name">${esc(r.name)}</div><div class="odb-row-val">${fmt(r)}</div>
        <div class="odb-track"><div class="odb-fill" style="width:${r.cents > 0 ? Math.max(1, r.cents / max * 100) : 0}%"></div></div></div>`).join('');
    };
    const AGES = ['0–30 days', '31–60 days', '61–90 days', 'Over 90 days'];
    const agingHtml = s.owed > 0
      ? bars(s.aging.map((c, i) => ({ name: AGES[i], cents: c })), r => money(r.cents), r => `${r.name} old: ${money(r.cents)}`)
      : '<div class="odb-empty">Nothing owed. Every invoice is paid.</div>';

    const mixTotal = s.mix.reduce((a, m) => a + m.cents, 0);
    const SW = ['var(--odb-s1)', 'var(--odb-s2)', 'var(--odb-s3)', 'var(--odb-s4)'];
    const pct = (c) => mixTotal ? Math.round(c / mixTotal * 100) : 0;
    const mixHtml = mixTotal
      ? `<div class="odb-stack">${s.mix.map((m, i) => m.cents ? `<div style="flex:${m.cents};background:${SW[i]}" data-tip="${m.label}: ${money(m.cents)} (${pct(m.cents)}%)"></div>` : '').join('')}</div>
         <div class="odb-legend">${s.mix.map((m, i) => `<div><span class="odb-sw" style="background:${SW[i]}"></span>${m.label}<span class="odb-row-val">${money(m.cents)} · ${pct(m.cents)}%</span></div>`).join('')}</div>`
      : '<div class="odb-empty">No payments in the last 90 days.</div>';

    const servicesHtml = s.topServices.length
      ? bars(s.topServices, r => money(r.cents), r => `${r.name}: ${money(r.cents)} invoiced`)
      : '<div class="odb-empty">No invoices in the last 90 days.</div>';

    const owedHtml = s.topOwed.length
      ? `<table class="odb-table"><thead><tr><th>Customer</th><th class="n">Invoices</th><th class="n">Oldest</th><th class="n">Owed</th></tr></thead><tbody>
         ${s.topOwed.map(o => `<tr><td>${esc(o.name)}</td><td class="n">${o.count}</td><td class="n">${o.oldest}d</td><td class="n"><strong>${money(o.cents)}</strong></td></tr>`).join('')}</tbody></table>`
      : '<div class="odb-empty">No one owes you anything.</div>';

    const teamHtml = s.team.length
      ? `<div class="odb-card"><h3>By farrier</h3><p class="odb-note">This month. Invoices are credited to whoever wrote them.</p>
         <table class="odb-table"><thead><tr><th>Farrier</th><th class="n">Invoices</th><th class="n">Invoiced</th><th class="n">Collected</th></tr></thead><tbody>
         ${s.team.map(t => `<tr><td>${esc(t.name)}</td><td class="n">${t.jobs}</td><td class="n">${money(t.invoiced)}</td><td class="n"><strong>${money(t.collected)}</strong></td></tr>`).join('')}</tbody></table></div>`
      : '';

    el.innerHTML = `<div class="odb${dark ? ' odb-dark' : ''}">
      <div class="odb-tiles">${tiles}</div>
      <div class="odb-grid">
        <div class="odb-card"><h3>Collected by month</h3><p class="odb-note">Last 6 months, card price included. This month so far.</p><div class="odb-cols">${cols}</div></div>
        <div class="odb-card"><h3>What's owed, by age</h3><p class="odb-note">Open balances by how long ago the invoice was written.</p>${agingHtml}</div>
        <div class="odb-card"><h3>How customers pay</h3><p class="odb-note">Money collected in the last 90 days.</p>${mixHtml}</div>
        <div class="odb-card"><h3>Top services</h3><p class="odb-note">Invoiced in the last 90 days.</p>${servicesHtml}</div>
        <div class="odb-card"><h3>Who owes the most</h3><p class="odb-note">Open balances, largest first.</p>${owedHtml}</div>
        ${teamHtml}
      </div>
      <div class="odb-tip"></div>
    </div>`;

    // Hover / tap tooltips for every mark.
    const rootEl = el.firstElementChild, tipEl = rootEl.querySelector('.odb-tip');
    const show = (e) => {
      const t = e.target.closest('[data-tip]');
      if (!t || !rootEl.contains(t)) { tipEl.style.display = 'none'; return; }
      const r = t.getBoundingClientRect();
      tipEl.textContent = t.getAttribute('data-tip');
      tipEl.style.left = Math.min(window.innerWidth - 90, Math.max(90, r.left + r.width / 2)) + 'px';
      tipEl.style.top = r.top + 'px';
      tipEl.style.display = 'block';
    };
    rootEl.addEventListener('mouseover', show);
    rootEl.addEventListener('click', show);
    rootEl.addEventListener('mouseleave', () => { tipEl.style.display = 'none'; });
    if (!root.__odbScroll) {
      root.__odbScroll = true;
      window.addEventListener('scroll', () => document.querySelectorAll('.odb-tip').forEach(t => { t.style.display = 'none'; }), { passive: true, capture: true });
    }
  }

  root.FarriOwnerDash = { compute, render, money };
})(typeof window !== 'undefined' ? window : globalThis);
