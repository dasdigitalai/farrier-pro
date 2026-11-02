// /api/daily-stats.js
// Vercel Cron Job — runs daily at 8:00 AM ET (13:00 UTC)
// Queries Firestore via REST API (no Admin SDK needed) and sends a
// beautifully formatted stats email to the FarriTech owner via Resend.
//
// SETUP:
//   1. Add this file to your farrier-pro repo at /api/daily-stats.js
//   2. Update vercel.json to add the cron config (see bottom of file)
//   3. Ensure these env vars are set in Vercel:
//        FIREBASE_API_KEY       — your Firebase Web API key
//        FIREBASE_PROJECT_ID    — farrier-pro
//        RESEND_API_KEY         — your Resend API key
//        STATS_EMAIL_TO         — david@dasdigitalai.com
//        CRON_SECRET            — any random string you pick (e.g. openssl rand -hex 32)

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'farrier-pro';
const BASE_URL   = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM       = 'FarriTech Stats <welcome@contact.dasdigitalai.com>';
const TO         = process.env.STATS_EMAIL_TO || 'david@dasdigitalai.com';

// ─── FIRESTORE HELPERS ───────────────────────────────────────────────────────

function val(field) {
  if (!field) return null;
  if ('stringValue'    in field) return field.stringValue;
  if ('integerValue'   in field) return Number(field.integerValue);
  if ('doubleValue'    in field) return Number(field.doubleValue);
  if ('booleanValue'   in field) return field.booleanValue;
  if ('timestampValue' in field) return new Date(field.timestampValue);
  if ('nullValue'      in field) return null;
  return null;
}

async function runQuery(structuredQuery, apiKey) {
  const res = await fetch(
    `${BASE_URL}:runQuery?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore runQuery failed: ${err}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data.filter(d => d.document) : [];
}

// Query a collection for docs where `field` is between two timestamps
async function queryByDateRange(collection, field, startISO, endISO, apiKey) {
  return runQuery({
    from: [{ collectionId: collection }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: [
          {
            fieldFilter: {
              field: { fieldPath: field },
              op: 'GREATER_THAN_OR_EQUAL',
              value: { timestampValue: startISO },
            },
          },
          {
            fieldFilter: {
              field: { fieldPath: field },
              op: 'LESS_THAN',
              value: { timestampValue: endISO },
            },
          },
        ],
      },
    },
  }, apiKey);
}

// Count all docs in a collection (no filter) — used for totals
async function countAll(collection, apiKey) {
  // Names only: a profile can carry a logo, and counting shouldn't download every farrier's.
  const docs = await runQuery({ from: [{ collectionId: collection }], select: { fields: [{ fieldPath: '__name__' }] } }, apiKey);
  return docs.length;
}

// ─── STATS COLLECTION ────────────────────────────────────────────────────────

async function collectStats(apiKey) {
  // Yesterday in UTC — Vercel runs at 13:00 UTC = 8 AM ET (EST) / 9 AM ET (EDT)
  const now       = new Date();
  const todayUTC  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const ydayUTC   = new Date(todayUTC - 86400000);
  const startISO  = ydayUTC.toISOString();
  const endISO    = todayUTC.toISOString();

  // Date label: "Monday, March 7, 2026"
  const dateLabel = ydayUTC.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
  });

  const [
    newSignupDocs,
    newLeadDocs,
    newBookingDocs,
    newPaidInvoiceDocs,
  ] = await Promise.all([
    // New paid subscribers — farriers whose subscription activated yesterday
    // createdAt is a timestamp on the farriers collection
    queryByDateRange('farriers',     'createdAt',  startISO, endISO, apiKey),
    // Leads — landing page form submissions (leads collection)
    queryByDateRange('leads',        'createdAt',  startISO, endISO, apiKey),
    // Bookings submitted by customers yesterday
    queryByDateRange('appointments', 'createdAt',  startISO, endISO, apiKey),
    // Invoices paid yesterday
    queryByDateRange('invoices',     'paidAt',     startISO, endISO, apiKey),
  ]);

  // Revenue: sum paidAmount on invoices paid yesterday
  const revenue = newPaidInvoiceDocs.reduce((sum, d) => {
    const amt = val(d.document.fields?.paidAmount) || val(d.document.fields?.total) || 0;
    return sum + Number(amt);
  }, 0);

  // All-time totals for context
  const [totalFarriers, totalLeads, totalBookings] = await Promise.all([
    countAll('farriers',     apiKey),
    countAll('leads',        apiKey),
    countAll('appointments', apiKey),
  ]);

  // Active logins — we don't have a lastLoginAt field yet, so we'll check
  // for farriers who have a lastSeen / lastActive field updated yesterday.
  // If the field doesn't exist yet, this returns 0 gracefully.
  const activeLoginDocs = await queryByDateRange('farriers', 'lastSeen', startISO, endISO, apiKey)
    .catch(() => []);

  return {
    dateLabel,
    startISO,
    endISO,
    newSignups:    newSignupDocs.length,
    newLeads:      newLeadDocs.length,
    activeLogins:  activeLoginDocs.length,
    newBookings:   newBookingDocs.length,
    revenue,
    totalFarriers,
    totalLeads,
    totalBookings,
    // Pass lead details for the table
    leadDetails: newLeadDocs.slice(0, 10).map(d => ({
      name:  val(d.document.fields?.name)  || val(d.document.fields?.fullName) || '—',
      email: val(d.document.fields?.email) || '—',
      phone: val(d.document.fields?.phone) || '—',
    })),
    bookingDetails: newBookingDocs.slice(0, 10).map(d => ({
      customer: val(d.document.fields?.customerName) || '—',
      date:     val(d.document.fields?.requestedDate)
                  ? new Date(val(d.document.fields.requestedDate)).toLocaleDateString('en-US', {month:'short',day:'numeric'})
                  : '—',
      service:  val(d.document.fields?.service) || val(d.document.fields?.notes) || '—',
    })),
  };
}

// ─── EMAIL HTML ──────────────────────────────────────────────────────────────

function buildEmailHTML(s) {
  const fmt = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const statCard = (emoji, label, value, sub, color) => `
    <td style="width:25%;padding:8px;">
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-top:3px solid ${color};border-radius:10px;padding:18px 14px;text-align:center;">
        <div style="font-size:26px;margin-bottom:6px;">${emoji}</div>
        <div style="font-size:28px;font-weight:800;color:#0f172a;font-family:Arial,sans-serif;">${value}</div>
        <div style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.06em;margin-top:4px;">${label}</div>
        ${sub ? `<div style="font-size:11px;color:#94a3b8;margin-top:3px;">${sub}</div>` : ''}
      </div>
    </td>`;

  const rowStyle = (i) => i % 2 === 0
    ? 'background:#f8fafc;'
    : 'background:#ffffff;';

  const leadsTable = s.leadDetails.length === 0
    ? `<p style="color:#94a3b8;font-size:13px;text-align:center;padding:16px 0;">No new leads yesterday.</p>`
    : `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin-top:8px;">
        <tr style="background:#1e3a5f;">
          <th style="color:#fff;font-weight:700;padding:8px 12px;text-align:left;border-radius:6px 0 0 0;">Name</th>
          <th style="color:#fff;font-weight:700;padding:8px 12px;text-align:left;">Email</th>
          <th style="color:#fff;font-weight:700;padding:8px 12px;text-align:left;border-radius:0 6px 0 0;">Phone</th>
        </tr>
        ${s.leadDetails.map((l, i) => `
          <tr style="${rowStyle(i)}">
            <td style="padding:8px 12px;color:#0f172a;font-weight:600;border-bottom:1px solid #e2e8f0;">${l.name}</td>
            <td style="padding:8px 12px;color:#2563eb;border-bottom:1px solid #e2e8f0;"><a href="mailto:${l.email}" style="color:#2563eb;text-decoration:none;">${l.email}</a></td>
            <td style="padding:8px 12px;color:#475569;border-bottom:1px solid #e2e8f0;">${l.phone}</td>
          </tr>`).join('')}
      </table>`;

  const bookingsTable = s.bookingDetails.length === 0
    ? `<p style="color:#94a3b8;font-size:13px;text-align:center;padding:16px 0;">No new bookings yesterday.</p>`
    : `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin-top:8px;">
        <tr style="background:#1e3a5f;">
          <th style="color:#fff;font-weight:700;padding:8px 12px;text-align:left;border-radius:6px 0 0 0;">Customer</th>
          <th style="color:#fff;font-weight:700;padding:8px 12px;text-align:left;">Date</th>
          <th style="color:#fff;font-weight:700;padding:8px 12px;text-align:left;border-radius:0 6px 0 0;">Service / Notes</th>
        </tr>
        ${s.bookingDetails.map((b, i) => `
          <tr style="${rowStyle(i)}">
            <td style="padding:8px 12px;color:#0f172a;font-weight:600;border-bottom:1px solid #e2e8f0;">${b.customer}</td>
            <td style="padding:8px 12px;color:#475569;border-bottom:1px solid #e2e8f0;">${b.date}</td>
            <td style="padding:8px 12px;color:#475569;border-bottom:1px solid #e2e8f0;">${b.service}</td>
          </tr>`).join('')}
      </table>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

  <!-- HEADER -->
  <tr><td style="background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);border-radius:12px 12px 0 0;padding:28px 32px;text-align:center;">
    <div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.6);letter-spacing:0.12em;text-transform:uppercase;margin-bottom:6px;">Daily Report</div>
    <div style="font-size:26px;font-weight:800;color:#ffffff;margin-bottom:4px;">FarriTech Stats</div>
    <div style="font-size:14px;color:rgba(255,255,255,0.7);">${s.dateLabel}</div>
  </td></tr>

  <!-- BODY -->
  <tr><td style="background:#ffffff;padding:28px 24px;border-radius:0 0 12px 12px;border:1px solid #e2e8f0;border-top:none;">

    <!-- STAT CARDS -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr>
        ${statCard('🆕', 'New Signups',   s.newSignups,   `${s.totalFarriers} total farriers`, '#2563eb')}
        ${statCard('📋', 'New Leads',     s.newLeads,     `${s.totalLeads} all-time`,          '#7c3aed')}
        ${statCard('📅', 'New Bookings',  s.newBookings,  `${s.totalBookings} all-time`,       '#0891b2')}
        ${statCard('💰', 'Revenue',       `$${fmt(s.revenue)}`, 'invoices paid',              '#15803d')}
      </tr>
    </table>

    <!-- ACTIVE LOGINS NOTE -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 18px;">
        <span style="font-size:18px;">👤</span>
        <span style="font-size:14px;font-weight:700;color:#1d4ed8;margin-left:8px;">Active Logins Yesterday: </span>
        <span style="font-size:14px;font-weight:800;color:#1e3a5f;">${s.activeLogins}</span>
        ${s.activeLogins === 0 ? `<span style="font-size:12px;color:#93c5fd;margin-left:8px;">(Requires <code style="background:#dbeafe;padding:1px 5px;border-radius:3px;">lastSeen</code> field — see setup note below)</span>` : ''}
      </td></tr>
    </table>

    <!-- LEADS TABLE -->
    <div style="font-size:15px;font-weight:800;color:#0f172a;margin-bottom:6px;padding-bottom:6px;border-bottom:2px solid #e2e8f0;">
      📋 New Leads <span style="font-size:13px;font-weight:500;color:#94a3b8;">(${s.newLeads} yesterday)</span>
    </div>
    ${leadsTable}

    <!-- BOOKINGS TABLE -->
    <div style="font-size:15px;font-weight:800;color:#0f172a;margin:20px 0 6px;padding-bottom:6px;border-bottom:2px solid #e2e8f0;">
      📅 New Bookings <span style="font-size:13px;font-weight:500;color:#94a3b8;">(${s.newBookings} yesterday)</span>
    </div>
    ${bookingsTable}

    <!-- ACTIVE LOGINS SETUP NOTE -->
    ${s.activeLogins === 0 ? `
    <div style="margin-top:20px;background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:14px 16px;">
      <div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:4px;">⚙️ Active Logins Setup</div>
      <div style="font-size:12px;color:#78350f;line-height:1.6;">
        To track active logins, add one line to your Firebase Auth <code>onAuthStateChanged</code> listener in <code>index.html</code>:<br>
        <code style="background:#fef9c3;padding:2px 6px;border-radius:3px;display:inline-block;margin-top:4px;">
          db.collection('farriers').doc(uid).update({ lastSeen: firebase.firestore.FieldValue.serverTimestamp() });
        </code>
      </div>
    </div>` : ''}

    <!-- FOOTER -->
    <div style="margin-top:28px;padding-top:16px;border-top:1px solid #e2e8f0;text-align:center;">
      <div style="font-size:12px;color:#94a3b8;">FarriTech Daily Stats · Delivered every morning at 8:00 AM ET</div>
      <div style="font-size:12px;color:#94a3b8;margin-top:4px;">
        <a href="https://farritech.com" style="color:#2563eb;text-decoration:none;">farritech.com</a>
        &nbsp;·&nbsp;
        <a href="https://console.firebase.google.com/project/farrier-pro" style="color:#2563eb;text-decoration:none;">Firebase Console</a>
        &nbsp;·&nbsp;
        <a href="https://vercel.com/dashboard" style="color:#2563eb;text-decoration:none;">Vercel Dashboard</a>
      </div>
    </div>

  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ─── SEND EMAIL ──────────────────────────────────────────────────────────────

async function sendStatsEmail(stats) {
  const subject = `📊 FarriTech Daily Stats — ${stats.newSignups} signup${stats.newSignups !== 1 ? 's' : ''}, ${stats.newLeads} lead${stats.newLeads !== 1 ? 's' : ''}, $${stats.revenue.toFixed(2)} revenue`;
  const html = buildEmailHTML(stats);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to: [TO], subject, html }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'Resend error');
  return data;
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Allow GET (from Vercel Cron) or POST (for manual trigger)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Verify cron secret — prevents unauthorized triggering
  // Vercel Cron passes the secret as Authorization: Bearer <CRON_SECRET>
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    const provided = auth.replace('Bearer ', '').trim();
    if (provided !== secret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey)      return res.status(500).json({ ok: false, error: 'Missing FIREBASE_API_KEY' });
  if (!RESEND_KEY)  return res.status(500).json({ ok: false, error: 'Missing RESEND_API_KEY' });

  try {
    const stats  = await collectStats(apiKey);
    const result = await sendStatsEmail(stats);
    console.log('Daily stats email sent:', result.id);
    return res.status(200).json({ ok: true, emailId: result.id, stats: {
      newSignups:   stats.newSignups,
      newLeads:     stats.newLeads,
      activeLogins: stats.activeLogins,
      newBookings:  stats.newBookings,
      revenue:      stats.revenue,
    }});
  } catch (err) {
    console.error('daily-stats error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
