import { ensureMetaApiConnection } from "./metaApiConnection";

let started = false;

/**
 * Called once from instrumentation.ts when the server boots. Errors are logged, not
 * thrown, so a missing/invalid MetaApi configuration doesn't crash the whole server —
 * the dashboard should still render (with an empty watchlist) while that gets fixed.
 *
 * Trading is manual-confirmation only: signals are detected and shown on the dashboard,
 * but nothing is sent to the broker until a user clicks Buy/Sell on a signal card (see
 * app/api/signals/[id]/execute/route.ts), which then runs the same risk limits and
 * kill-switch checks documented in README.md.
 */
export function startMarketEngine(): void {
  if (started) return;
  started = true;

  ensureMetaApiConnection().catch((error: unknown) => {
    console.error("[market] failed to start market engine:", error);
  });
}
