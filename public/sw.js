// Deliberately minimal: this app is a live-trading dashboard, so the single most
// important rule here is that nothing trading-relevant is ever served stale. This
// service worker does two things -- transparently retry a page navigation that fails on
// a genuinely transient connection blip (see fetchNavigationWithRetry below), and if
// every retry is exhausted, show a static "connection lost" page instead of letting the
// browser's own generic network-error screen dead-end the user -- and nothing else. It
// was previously also a static-asset cache, which was retired because a persistent
// worker could combine assets from different Railway deployments and trigger a
// page-load failure of its own; that kind of caching is gone for good, not just
// disabled. The one thing cached here (offline.html) is categorically different: a
// single static file with zero trading data, never updated independently of a fresh
// deployment (see CACHE_NAME below), so it can never go stale in a way that matters --
// unlike the old asset cache, there's nothing here for two deployments' bytes to
// conflict over. It still has no fake "offline dashboard": if the network is down, this
// app is useless anyway (no live prices, no execution), so showing old data would be
// actively misleading -- offline.html shows nothing but that honest fact and a retry
// button, never cached trading state.
const CACHE_NAME = "forex-ai-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.add(OFFLINE_URL))
      .catch(() => {
        // Best-effort -- a failed precache just means a genuine sustained outage falls
        // through to the browser's own native error page instead, same as before this
        // fallback existed.
      })
  );
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
// attempts, before letting the real failure through. This exists to silently absorb a
// genuinely transient connection blip (confirmed real, not a guess -- the same URL was
// observed landing on a different physical Railway edge server, x-railway-edge: jnb1 vs
// lhr1, at different points in the same session, which can strand an in-flight
// navigation on a now-stale connection), not to paper over a real, sustained outage. The
// confirmed trigger is a mobile-data connection (no VPN involved), where a carrier-side
// tower handoff or re-routing event can take 1-3 seconds to settle -- so the backoff
// below is spaced out to actually span a typical handoff instead of giving up mid-way
// through one. A genuine, sustained outage still fails after these -- see the fetch
// handler below for what happens then.
const NAVIGATE_RETRY_DELAYS_MS = [500, 1000, 2000];

async function fetchNavigationWithRetry(request) {
  let lastError;
  for (let attempt = 0; attempt <= NAVIGATE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      // A fresh clone each attempt -- a Request's body can only be read once, and a GET
      // navigation has none anyway, but this stays correct if that ever changes.
      return await fetch(request.clone());
    } catch (error) {
      lastError = error;
      if (attempt < NAVIGATE_RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, NAVIGATE_RETRY_DELAYS_MS[attempt]));
      }
    }
  }
  // Every retry genuinely failed -- a sustained outage, not a blip. Serve the
  // precached, static, zero-trading-data offline page instead of leaving the browser to
  // show its own generic (and less actionable) network-error screen. Falls through to
  // that same browser error only if even the offline page itself isn't cached yet (a
  // brand-new install whose "install" precache never got the chance to finish).
  const offline = await caches.match(OFFLINE_URL, { cacheName: CACHE_NAME });
  if (offline) return offline;
  throw lastError;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.mode !== "navigate") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(fetchNavigationWithRetry(request));
});
