// Deliberately minimal: this app is a live-trading dashboard, so the single most
// important rule here is that nothing trading-relevant is ever served stale. This
// service worker does exactly one thing -- transparently retry a page navigation that
// fails on a genuinely transient connection blip (see fetchNavigationWithRetry below) --
// and nothing else. It was previously also a static-asset cache, which was retired
// because a persistent worker could combine assets from different Railway deployments
// and trigger a page-load failure of its own; caching is gone for good, not just
// disabled, so that failure mode can't come back. It has no offline fallback: if the
// network is down, this app is useless anyway (no live prices, no execution), so a fake
// "offline" dashboard showing old data would be actively misleading, not helpful.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
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
  if (request.method !== "GET" || request.mode !== "navigate") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(fetchNavigationWithRetry(request));
});
