// Deliberately minimal: this app is a live-trading dashboard, so the single most
// important rule here is that nothing trading-relevant is ever served stale. This
// service worker exists to satisfy PWA installability, speed up repeat loads of
// content-hashed build assets, and transparently retry a page load that fails on a
// genuinely transient connection blip (see fetchNavigationWithRetry below) -- it never
// caches API responses, the SSE stream, or page navigations, and it has no offline
// fallback. If the network is down, this app is useless anyway (no live prices, no
// execution), so a fake "offline" dashboard showing old data would be actively
// misleading, not helpful.

const CACHE_NAME = "forex-ai-shell-v1";
// Next.js build output under /_next/static/** is content-hashed (a change in content
// always means a new URL), so caching it aggressively can never serve stale code --
// plus icons/fonts, which change rarely and aren't trading data.
const CACHEABLE_PATTERNS = [/^\/_next\/static\//, /\.(?:png|svg|ico|woff2?)$/];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// How many times to retry a failed page navigation, and how long to wait between
// attempts, before letting the real failure through. Deliberately short: this exists to
// silently absorb a genuinely transient connection blip (confirmed real, not a guess --
// the same URL was observed landing on a different physical Railway edge server,
// x-railway-edge: jnb1 vs lhr1, at different points in the same session, which can
// strand an in-flight navigation on a now-stale connection), not to paper over a real,
// sustained outage. A near-immediate retry opens a fresh connection and very often
// succeeds invisibly; a genuine outage still fails after these and shows the real
// browser error, exactly as it would with no service worker at all.
const NAVIGATE_RETRY_ATTEMPTS = 2;
const NAVIGATE_RETRY_DELAY_MS = 400;

async function fetchNavigationWithRetry(request) {
  let lastError;
  for (let attempt = 0; attempt <= NAVIGATE_RETRY_ATTEMPTS; attempt++) {
    try {
      // A fresh clone each attempt -- a Request's body can only be read once, and a GET
      // navigation has none anyway, but this stays correct if that ever changes.
      return await fetch(request.clone());
    } catch (error) {
      lastError = error;
      if (attempt < NAVIGATE_RETRY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, NAVIGATE_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Page navigations: never cached (same "nothing trading-relevant is ever served
  // stale" rule as everything else here) -- just retried transparently a couple of
  // times on a genuine network-level failure before giving up. See
  // fetchNavigationWithRetry's own doc comment for why.
  if (request.mode === "navigate") {
    event.respondWith(fetchNavigationWithRetry(request));
    return;
  }

  // Every /api/* route (prices, positions, risk-status, signal execution, the SSE
  // stream) is left completely untouched -- always goes straight to the network,
  // exactly as if this service worker didn't exist.
  if (url.pathname.startsWith("/api/")) return;
  if (!CACHEABLE_PATTERNS.some((pattern) => pattern.test(url.pathname))) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const networkFetch = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
