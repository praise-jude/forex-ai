import { ensureMetaApiConnection, isAccountConfigured } from "./metaApiConnection";
import { startAutoExecutionListener } from "./autoExecutionListener";
import { startConnectionWatcher } from "./connectionWatcher";

let started = false;

/**
 * Called once from instrumentation.ts when the server boots. Errors are logged, not
 * thrown, so a missing/invalid MetaApi configuration doesn't crash the whole server —
 * the dashboard should still render (with an empty watchlist) while that gets fixed.
 *
 * Trading defaults to manual-confirmation only (engine mode always boots to ANALYSIS,
 * see engineMode.ts): signals are detected and shown on the dashboard, but nothing is
 * sent to the broker until a user clicks Buy/Sell (app/api/signals/[id]/execute/route.ts)
 * or explicitly switches engine mode to DEMO/LIVE (app/api/engine-mode/route.ts) — either
 * path runs the same risk limits and kill-switch checks documented in README.md.
 */
export function startMarketEngine(): void {
  if (started) return;
  started = true;

  ensureMetaApiConnection("live").catch((error: unknown) => {
    console.error("[market] failed to start live engine:", error);
  });

  if (isAccountConfigured("demo")) {
    ensureMetaApiConnection("demo").catch((error: unknown) => {
      console.error("[market] failed to start demo engine:", error);
    });
  } else {
    console.log("[market] METAAPI_DEMO_TOKEN/METAAPI_DEMO_ACCOUNT_ID not set — DEMO engine mode will be unavailable");
  }

  startAutoExecutionListener();
  startConnectionWatcher();
}
