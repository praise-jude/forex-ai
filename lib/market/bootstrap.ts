import { ensureMetaApiConnection, isAccountConfigured } from "./metaApiConnection";
import { checkEngineModeAfterRestart } from "./engineMode";
import { startAutoExecutionListener } from "./autoExecutionListener";
import { startConnectionWatcher } from "./connectionWatcher";
import { startConnectionWatchdog } from "./connectionWatchdog";
import { startNewsFilter } from "./newsFilter";
import { startCurrencyStrength } from "./currencyStrength";
import { startRollingCorrelation } from "./rollingCorrelation";
import { startPositionManager } from "./positionManager";
import { startPositionInvalidation } from "./positionInvalidation";
import { startWeeklyDigest } from "./weeklyDigest";
import { startDailyDigest } from "./dailyDigest";
import { signalStore } from "./signalStore";
import { positionStore } from "./positionStore";
import { tradeJournal } from "./tradeJournal";

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

  // Fire-and-forget, same as ensureMetaApiConnection below -- reloads recent
  // signals/execution/journal history from the DB (see signalStore.ts/positionStore.ts/
  // tradeJournal.ts's own hydrate()) so a restart doesn't blank the dashboard, reopen
  // hasExecuted()'s idempotency window, or lose the trade journal (tradeJournal.ts used
  // to persist to a local JSON file, which doesn't survive a Railway redeploy the way a
  // real database does). No-ops (and logs once) when DATABASE_URL isn't set -- the
  // engine itself doesn't wait on this, since the first real signal/execution is always
  // much further off than a DB round trip.
  Promise.all([signalStore.hydrate(), positionStore.hydrate(), tradeJournal.hydrate()]).catch((error: unknown) => {
    console.error("[market] failed to hydrate signal/execution/journal history from the database:", error);
  });

  // Fire-and-forget, same reasoning as above -- if this restart silently dropped engine
  // mode out of LIVE/DEMO back to its safe ANALYSIS default (see engineMode.ts), sends a
  // push notification rather than that only being discoverable by chance.
  checkEngineModeAfterRestart().catch((error: unknown) => {
    console.error("[market] failed to check engine mode across restart:", error);
  });

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
  startConnectionWatchdog();
  startNewsFilter();
  startCurrencyStrength();
  startRollingCorrelation();
  // Unlike auto-execution above, these two manage trades already on the books rather
  // than opening new ones -- they run unconditionally, independent of engine mode/kill
  // switch (see positionManager.ts's own doc comment), governed only by each account's
  // own positionManagementEnabled config.
  startPositionManager();
  startPositionInvalidation();
  startWeeklyDigest();
  startDailyDigest();
}
