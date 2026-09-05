export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Safety net: a single unhandled promise rejection (a stray fire-and-forget task,
    // a broker/MetaApi SDK fault mid-execution) must never take down the whole Next.js
    // process -- which is exactly what surfaces client-side as the browser's "This page
    // couldn't load" network-error page when the server drops the in-flight request.
    // Log it loudly and keep serving instead. Registered once at boot, before any of
    // the engine's own fire-and-forget work starts.
    if (!(globalThis as { __rejectionGuardInstalled?: boolean }).__rejectionGuardInstalled) {
      (globalThis as { __rejectionGuardInstalled?: boolean }).__rejectionGuardInstalled = true;
      process.on("unhandledRejection", (reason) => {
        console.error("[process] unhandled rejection (kept alive):", reason);
      });
    }
    const { startMarketEngine } = await import("./lib/market/bootstrap");
    startMarketEngine();
  }
}
