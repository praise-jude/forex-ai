import { ensureMetaApiConnection } from "./metaApiConnection";
import { startExecutionEngine } from "./executionEngine";

let started = false;

/**
 * Called once from instrumentation.ts when the server boots. Errors are logged, not
 * thrown, so a missing/invalid MetaApi configuration doesn't crash the whole server —
 * the dashboard should still render (with an empty watchlist) while that gets fixed.
 *
 * Trading is fully automatic once this starts: every signal the engine produces is
 * handed to the execution engine, gated only by the risk limits and kill-switch file
 * documented in README.md. Set the kill switch before boot if you want signals-only.
 */
export function startMarketEngine(): void {
  if (started) return;
  started = true;

  ensureMetaApiConnection().catch((error: unknown) => {
    console.error("[market] failed to start market engine:", error);
  });
  startExecutionEngine();
}
