"use client";

import { useEffect } from "react";

/** Registers public/sw.js, whose only job is retrying a page navigation that fails on a
 * transient connection blip (see sw.js's own doc comment). Also clears any asset cache
 * left behind by an older version of this worker that used to cache static assets --
 * that caching was retired because a persistent asset cache could combine files from
 * different Railway deployments and trigger a page-load failure of its own; the current
 * worker never writes to the Cache Storage API, so this cleanup is one-time and safe to
 * repeat indefinitely. Silently no-ops on unsupported browsers or over plain HTTP
 * (service workers require a secure context, localhost excepted). */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    void caches
      .keys()
      .then((cacheNames) => Promise.all(cacheNames.filter((name) => name.startsWith("forex-ai-shell-")).map((name) => caches.delete(name))))
      .catch(() => {
        // Best-effort cleanup; registration below still proceeds either way.
      });
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {
      // Best-effort; a failed registration shouldn't be user-visible.
    });
  }, []);

  return null;
}
