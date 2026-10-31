// Server-side Firestore access for the api/ functions.
//
// Google blocks service-account key downloads on this project (org policy), so the
// server doesn't use firebase-admin. Instead it signs in as a dedicated Firebase Auth
// user (SERVER_AUTH_EMAIL / SERVER_AUTH_PASSWORD in Vercel env) whose uid the Firestore
// rules grant exactly what the server needs — the locked farrierSecrets collection,
// reading farrier profiles, and marking invoices paid. Nothing else.
//
// Files under api/_lib are helpers, not deployed as endpoints (underscore prefix).

const PROJECT_ID = 'farrier-pro';
// The web API key is public (it ships in every page); env var preferred if set.
const API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyAQ1LaWG9lE9j5h6X0T0YQKa_j04vJZHE4';
const DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const IDT = 'https://identitytoolkit.googleapis.com/v1';

// ── Server identity ──
//
// Firebase rate-limits password sign-ins (TOO_MANY_ATTEMPTS_TRY_LATER), and a failing server
// login used to be retried by every request, which kept the limit in force. So: concurrent
// callers share one sign-in, a refresh token renews the session without the password, and
// after a failure the instance waits before trying again instead of hammering Firebase.
const SIGN_IN_COOLDOWN_MS = 60_000;
let cached = null; // { idToken, refreshToken, uid, expiresAt }
let inflight = null;
let failed = null; // { error, until }
export async function serverAuth() {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached;
  if (failed && failed.until > Date.now()) throw failed.error;
  inflight ||= renewServerAuth()
    .catch(err => { failed = { error: err, until: Date.now() + SIGN_IN_COOLDOWN_MS }; throw err; })
    .finally(() => { inflight = null; });
  return inflight;
}
async function renewServerAuth() {
  if (cached?.refreshToken) {
    const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cached.refreshToken }).toString(),
    });
    if (r.ok) {
      const d = await r.json();
      cached = { idToken: d.id_token, refreshToken: d.refresh_token || cached.refreshToken, uid: d.user_id || cached.uid,
        expiresAt: Date.now() + Number(d.expires_in || 3600) * 1000 };
      return cached;
    }
  }
  const email = process.env.SERVER_AUTH_EMAIL, password = process.env.SERVER_AUTH_PASSWORD;
  if (!email || !password) throw new Error('SERVER_AUTH_EMAIL / SERVER_AUTH_PASSWORD not configured');
  const r = await fetch(`${IDT}/accounts:signInWithPassword?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Server sign-in failed: ' + (d.error?.message || r.status));
  cached = { idToken: d.idToken, refreshToken: d.refreshToken, uid: d.localId, expiresAt: Date.now() + Number(d.expiresIn || 3600) * 1000 };
  failed = null;
  return cached;
}

// ── Caller identity ──
// Verifies a Firebase ID token from the Authorization header (Bearer <token>) with
// Firebase itself. Returns { uid, email } or null.
export async function callerFromRequest(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const idToken = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!idToken) return null;
  const r = await fetch(`${IDT}/accounts:lookup?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }),
  });
  if (!r.ok) return null;
  const u = (await r.json()).users?.[0];
  return u ? { uid: u.localId, email: (u.email || '').toLowerCase(), idToken } : null;
}

// ── Firestore value encoding ──
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
  return { stringValue: String(v) };
}
function dec(v) {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, dec(x)]));
  return undefined;
}

// ── Firestore document helpers (run as the server user) ──
export async function getDoc(path) {
  const { idToken } = await serverAuth();
  const r = await fetch(`${DOCS}/${path}`, { headers: { Authorization: `Bearer ${idToken}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Firestore read ${path} failed: ${r.status} (server uid ${cached?.uid}) ${await r.text()}`);
  const d = await r.json();
  return Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, dec(v)]));
}

// Lists a collection (all pages). Returns [{ id, ...fields }]. Optional field mask.
export async function listDocs(collection, fieldMask = []) {
  const { idToken } = await serverAuth();
  const out = [];
  let pageToken = '';
  do {
    const qs = [`pageSize=300`, ...fieldMask.map(f => `mask.fieldPaths=${encodeURIComponent(f)}`), pageToken ? `pageToken=${pageToken}` : ''].filter(Boolean).join('&');
    const r = await fetch(`${DOCS}/${collection}?${qs}`, { headers: { Authorization: `Bearer ${idToken}` } });
    if (!r.ok) throw new Error(`Firestore list ${collection} failed: ${r.status} (server uid ${cached?.uid}) ${await r.text()}`);
    const d = await r.json();
    for (const doc of d.documents || []) {
      out.push({ id: doc.name.split('/').pop(), ...Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, dec(v)])) });
    }
    pageToken = d.nextPageToken || '';
  } while (pageToken);
  return out;
}

// Documents in `collection` whose `field` equals any of `values` (Firestore allows up to 30).
// Returns [{ id, ...fields }].
export async function queryIn(collection, field, values) {
  const { idToken } = await serverAuth();
  const structuredQuery = {
    from: [{ collectionId: collection }],
    where: { fieldFilter: { field: { fieldPath: field }, op: 'IN', value: { arrayValue: { values: values.slice(0, 30).map(enc) } } } },
  };
  const r = await fetch(`${DOCS}:runQuery`, {
    method: 'POST', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!r.ok) throw new Error(`Firestore query ${collection} failed: ${r.status} (server uid ${cached?.uid}) ${await r.text()}`);
  return (await r.json()).filter(x => x.document).map(({ document: doc }) =>
    ({ id: doc.name.split('/').pop(), ...Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, dec(v)])) }));
}

// Writes only the given fields (merge). `deleteFields` removes fields. Creates the doc if missing.
export async function patchDoc(path, fields = {}, deleteFields = []) {
  const { idToken } = await serverAuth();
  const mask = [...Object.keys(fields), ...deleteFields].map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
  const body = { fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, enc(v)])) };
  const r = await fetch(`${DOCS}/${path}?${mask}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Firestore write ${path} failed: ${r.status} (server uid ${cached?.uid}) ${await r.text()}`);
  return true;
}

// Deletes a document (no error if it's already gone).
export async function deleteDoc(path) {
  const { idToken } = await serverAuth();
  const r = await fetch(`${DOCS}/${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${idToken}` } });
  if (!r.ok && r.status !== 404) throw new Error(`Firestore delete ${path} failed: ${r.status} (server uid ${cached?.uid}) ${await r.text()}`);
  return true;
}

// ── Transactions ──
// runTransaction(async tx => { const inv = await tx.get('invoices/x'); tx.patch('invoices/x', {...}); })
// Optimistic: reads are plain reads, and every write is committed together with a
// precondition that the document is exactly as it was read (same updateTime, or still
// missing). If anything changed in between, the commit is refused and the whole function
// runs again on fresh data. tx.create() also refuses to overwrite an existing document.
// (Firestore won't let this server user open a real transaction — beginTransaction is
// PERMISSION_DENIED — but preconditions give the same guarantees for these writes.)
const DOC_NAME = `projects/${PROJECT_ID}/databases/(default)/documents`;
export async function runTransaction(fn, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    const { idToken } = await serverAuth();
    const headers = { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' };
    const seen = {}; // path -> updateTime, or null if the document didn't exist
    const writes = [];
    const precondition = (path) => path in seen
      ? (seen[path] ? { updateTime: seen[path] } : { exists: false })
      : undefined;
    const encFields = (fields) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, enc(v)]));
    const tx = {
      async get(path) {
        const r = await fetch(`${DOCS}/${path}`, { headers });
        if (r.status === 404) { seen[path] = null; return null; }
        if (!r.ok) throw new Error(`Firestore read ${path} failed: ${r.status} (server uid ${cached?.uid}) ${await r.text()}`);
        const d = await r.json();
        seen[path] = d.updateTime;
        return Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, dec(v)]));
      },
      patch(path, fields) {
        const pre = precondition(path);
        writes.push({
          update: { name: `${DOC_NAME}/${path}`, fields: encFields(fields) },
          updateMask: { fieldPaths: Object.keys(fields).map(f => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f) ? f : `\`${f}\``) },
          ...(pre ? { currentDocument: pre } : {}),
        });
      },
      create(path, fields) {
        writes.push({ update: { name: `${DOC_NAME}/${path}`, fields: encFields(fields) }, currentDocument: { exists: false } });
      },
    };
    const result = await fn(tx);
    if (!writes.length) return result;
    const commit = await fetch(`${DOCS}:commit`, { method: 'POST', headers, body: JSON.stringify({ writes }) });
    if (commit.ok) return result;
    const text = await commit.text();
    // Something changed since we read it (FAILED_PRECONDITION / ALREADY_EXISTS / ABORTED): run again.
    if ([400, 409].includes(commit.status) && /FAILED_PRECONDITION|ALREADY_EXISTS|ABORTED/.test(text) && attempt < attempts) continue;
    throw new Error(`Firestore commit failed: ${commit.status} (server uid ${cached?.uid}) ${text}`);
  }
}

// ── Payment secrets ──
// farrierSecrets/{uid} is denied to every browser by the rules; only the server user
// can read or write it. Shaped to hold other processors (e.g. Stax) alongside Stripe.
//
// Legacy: secret keys used to live on the public farriers/{uid} profile. The first time
// the server needs a farrier's key it moves it here and deletes it from the profile.
export async function getStripeSecretKey(farrierId) {
  if (!farrierId) return '';
  const secrets = await getDoc(`farrierSecrets/${farrierId}`);
  if (secrets?.stripeSecretKey) return secrets.stripeSecretKey;
  const profile = await getDoc(`farriers/${farrierId}`);
  const legacy = profile?.stripeSecretKey || '';
  if (legacy && /^(sk|rk)_/.test(legacy)) {
    await patchDoc(`farrierSecrets/${farrierId}`, { stripeSecretKey: legacy, migratedAt: new Date() });
    await patchDoc(`farriers/${farrierId}`, {}, ['stripeSecretKey']);
    return legacy;
  }
  return '';
}

export async function setStripeSecretKey(farrierId, key) {
  if (key) await patchDoc(`farrierSecrets/${farrierId}`, { stripeSecretKey: key, updatedAt: new Date() });
  else await patchDoc(`farrierSecrets/${farrierId}`, {}, ['stripeSecretKey']);
  // Never leave a copy on the public profile.
  await patchDoc(`farriers/${farrierId}`, {}, ['stripeSecretKey']);
}

// ── Google Calendar ──
// The refresh token lives in farrierSecrets/{uid}.googleRefreshToken; browsers only ever
// get short-lived access tokens from api/google-calendar-auth.
//
// Legacy: tokens used to sit on the public farriers/{uid} profile. The first time the
// server looks for a farrier's token it moves any refresh token here and deletes every
// Google token field from the profile.
const LEGACY_GOOGLE_FIELDS = ['googleAccessToken', 'googleRefreshToken', 'googleTokenExpiry'];

export async function getGoogleRefreshToken(farrierId) {
  if (!farrierId) return '';
  const secrets = await getDoc(`farrierSecrets/${farrierId}`);
  if (secrets?.googleRefreshToken) return secrets.googleRefreshToken;
  const profile = await getDoc(`farriers/${farrierId}`);
  if (!profile || !LEGACY_GOOGLE_FIELDS.some(f => profile[f])) return '';
  const legacy = profile.googleRefreshToken || '';
  if (legacy) await patchDoc(`farrierSecrets/${farrierId}`, { googleRefreshToken: legacy, googleMigratedAt: new Date() });
  await patchDoc(`farriers/${farrierId}`, {}, LEGACY_GOOGLE_FIELDS);
  return legacy;
}

export async function setGoogleRefreshToken(farrierId, token) {
  if (token) await patchDoc(`farrierSecrets/${farrierId}`, { googleRefreshToken: token, googleUpdatedAt: new Date() });
  else await patchDoc(`farrierSecrets/${farrierId}`, {}, ['googleRefreshToken']);
  // Never leave a copy on the public profile.
  await patchDoc(`farriers/${farrierId}`, {}, LEGACY_GOOGLE_FIELDS);
}

// FarriTech support staff (supportAdmins/{uid}, set by hand in the Firebase console).
export async function isSupportAdmin(uid) {
  if (!uid) return false;
  const a = await getDoc(`supportAdmins/${uid}`);
  return !!a && a.active !== false;
}

// Gate for endpoints that send messages: a signed-in farrier/team member, FarriTech support
// staff, or the server itself. Returns { caller } or { status, error } with the reason —
// a failed lookup (server sign-in, Firestore) is a 500, not a silent "not a farrier".
export async function authorizeSender(req, tag) {
  const caller = await callerFromRequest(req).catch(() => null);
  if (!caller) return { status: 401, error: 'Please sign in again' };
  let lookupError = null;
  const check = (fn) => fn(caller.uid).catch(err => { lookupError = err; return false; });
  if ((await check(isFarrier)) || (await check(isSupportAdmin))) return { caller };
  if (lookupError) {
    console.error(`${tag}: could not verify caller`, caller.uid, lookupError);
    return { status: 500, error: 'Could not verify your account. Please try again.' };
  }
  console.warn(`${tag}: no farrier profile for`, caller.uid, caller.email);
  return { status: 403, error: 'No farrier account found for this login' };
}

export async function isFarrier(uid) {
  if (!uid) return false;
  const { uid: serverUid } = await serverAuth();
  if (uid === serverUid) return true;
  // A farrier with their own profile, or one who works in someone's business (_lib/team.js).
  return !!(await getDoc(`farriers/${uid}`)) || !!(await getDoc(`businessMembers/${uid}`));
}
