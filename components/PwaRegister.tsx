"use client";

import { useEffect } from "react";

/** Registers public/sw.js, whose job is retrying a page navigation that fails on a
 * transient connection blip, and falling back to a static "connection lost" page (zero
 * trading data) if every retry is exhausted (see sw.js's own doc comment). Unregisters
 * every existing registration first, rather than relying on the browser's own byte-diff
 * update check -- this app has already observed the same URL served with different
 * bytes from different Railway edge nodes mid-session, which can make that check keep
 * resolving against a stale copy and never actually replace an old worker. Also clears
 * any cache left behind by the OLDER version of this worker that used to cache build
 * assets (`forex-ai-shell-*`) -- that caching was retired because a persistent asset
 * cache could combine files from different Railway deployments and trigger a page-load
 * failure of its own. The current worker's own cache (`forex-ai-offline-v1`, holding
 * only the static offline page) is a different, narrower thing and isn't touched by
 * this sweep -- sw.js's own `activate` handler manages that one. Silently no-ops on
 * unsupported browsers or over plain HTTP (service workers require a secure context,
 * localhost excepted). */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => {
        // Best-effort; registration below still proceeds either way.
      })
      .then(() =>
        caches
          .keys()
          .then((cacheNames) => Promise.all(cacheNames.filter((name) => name.startsWith("forex-ai-shell-")).map((name) => caches.delete(name))))
      )
      .catch(() => {
        // Best-effort cleanup; registration below still proceeds either way.
      })
      .then(() => navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }))
      .catch(() => {
        // Best-effort; a failed registration shouldn't be user-visible.
      });
  }, []);

  return null;
}
