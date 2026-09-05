"use client";

import { useEffect } from "react";

/** Registers public/sw.js, whose only job is retrying a page navigation that fails on a
 * transient connection blip (see sw.js's own doc comment). Unregisters every existing
 * registration first, rather than relying on the browser's own byte-diff update check --
 * this app has already observed the same URL served with different bytes from different
 * Railway edge nodes mid-session, which can make that check keep resolving against a
 * stale copy and never actually replace an old worker. Also clears any asset cache left
 * behind by the older version of this worker that used to cache static assets -- that
 * caching was retired because a persistent asset cache could combine files from
 * different Railway deployments and trigger a page-load failure of its own; the current
 * worker never writes to the Cache Storage API, so this cleanup is one-time and safe to
 * repeat indefinitely. Silently no-ops on unsupported browsers or over plain HTTP
 * (service workers require a secure context, localhost excepted). */
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
