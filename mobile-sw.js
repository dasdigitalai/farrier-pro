// FarriTech Mobile Service Worker
// v4: same-origin cache-first used to match the WHOLE origin, which meant that if
// '/mobile' was ever served a bad response once (a deploy race, a rewrite hiccup),
// that response got cached under the '/mobile' key and kept being replayed forever
// on that phone — showing the desktop dashboard inside the installed mobile app.
// Same-origin cache-first is now scoped to the exact app-shell paths below, and the
// version bump flushes any bad entries a phone may already have cached under v3.
const CACHE_NAME = 'farritech-mobile-v10';

// The app shell: small set of files needed to boot the UI instantly on repeat opens.
const APP_SHELL = [
  '/mobile',
  '/mobile-manifest.json',
  '/public/farritech_logo_square.png',
  '/inventory-catalog.js',
  '/api-auth.js',
  '/lib/pricing.js',
  '/lib/owner-dashboard.js',
  '/supply-catalog.json',
];

const APP_SHELL_PATHS = new Set(APP_SHELL);

// The HTML document itself always needs the freshest deploy when online — cache
// is only a fallback for offline use, never the default. Stale-while-revalidate
// was showing the previous deploy's code until a second app open (or a forced
// cache clear) caught up with the background refresh.
const NETWORK_FIRST_PATHS = new Set(['/mobile', '/inventory-catalog.js', '/api-auth.js', '/lib/pricing.js', '/lib/owner-dashboard.js', '/supply-catalog.json']);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .catch(() => {}) // don't fail install if e.g. offline during first install
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => clients.claim())
  );
});

// Third-party hosts safe to cache whole-origin: libraries that rarely change and are
// expensive to re-download on cellular (fonts, Maps, Stripe.js). Same-origin requests
// are handled separately below — only the exact APP_SHELL paths get cache-first there,
// so a bad response for one path (e.g. '/') can never get served in place of another
// (e.g. '/mobile').
const CACHE_FIRST_ORIGINS = new Set([
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://maps.googleapis.com',
  'https://js.stripe.com',
  'https://www.gstatic.com', // Firebase SDK scripts
  'https://firebasestorage.googleapis.com', // horse photos — viewable offline once loaded once
]);

self.addEventListener('fetch', event => {
  const req = event.request;

  // Never intercept non-GET requests (payments, SMS, email, Firestore writes, etc.)
  // — those must always go straight to the network.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin API calls (e.g. /api/*) must always be fresh — never cached.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  if (url.origin === self.location.origin && !APP_SHELL_PATHS.has(url.pathname)) {
    // Any same-origin path outside the app shell (e.g. '/', '/login', '/signup') must
    // always be fetched fresh so this service worker never serves one page's content
    // in place of another's.
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  if (url.origin === self.location.origin && NETWORK_FIRST_PATHS.has(url.pathname)) {
    // Network-first, cache as an offline fallback only — this is the actual app
    // code, so a farrier online should always get today's deploy, not yesterday's.
    event.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  if (url.origin === self.location.origin || CACHE_FIRST_ORIGINS.has(url.origin)) {
    // Stale-while-revalidate: serve the cached copy instantly if we have one
    // (so the app opens fast even on a slow connection), and refresh it in
    // the background so the next open gets any update.
    event.respondWith(
      caches.match(req).then(cached => {
        const network = fetch(req).then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Everything else (Firebase Firestore/Auth channels, etc.): network first,
  // falling back to cache only if the network is unreachable.
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});
