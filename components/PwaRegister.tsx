"use client";

import { useEffect } from "react";

/** Registers public/sw.js once on mount. Silently no-ops on unsupported browsers or over
 * plain HTTP (service workers require a secure context, localhost excepted) -- the rest
 * of the app works identically either way, this only affects installability/asset caching. */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {
      // Best-effort; a failed registration shouldn't be user-visible.
    });
  }, []);

  return null;
}
