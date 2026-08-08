// Deliberately minimal: this app is a live-trading dashboard, so the single most
// important rule here is that nothing trading-relevant is ever served stale. This
// service worker exists only to satisfy PWA installability and to speed up repeat loads
// of content-hashed build assets -- it never caches API responses, the SSE stream, or
// page navigations, and it has no offline fallback. If the network is down, this app is
// useless anyway (no live prices, no execution), so a fake "offline" dashboard showing
// old data would be actively misleading, not helpful.

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

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Every /api/* route (prices, positions, risk-status, signal execution, the SSE
  // stream) and every page navigation is left completely untouched -- always goes
  // straight to the network, exactly as if this service worker didn't exist.
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
