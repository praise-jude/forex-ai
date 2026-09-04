"use client";

import { useEffect } from "react";

/** Retires the old shell service worker and its caches. A live dashboard must always use
 * the deployment's current Next.js document and chunks; a persistent worker can otherwise
 * combine assets from different Railway deployments and trigger a page-load failure. */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker
      .getRegistrations()
      .then(async (registrations) => {
        await Promise.all(registrations.map((registration) => registration.unregister()));
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.filter((name) => name.startsWith("forex-ai-shell-")).map((name) => caches.delete(name)));
      })
      .catch(() => {
        // Best-effort cleanup; the page remains usable if service-worker APIs are unavailable.
      });
  }, []);

  return null;
}
