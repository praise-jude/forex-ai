import { ensureMetaApiConnection, isAccountConfigured } from "./metaApiConnection";
import { checkEngineModeAfterRestart } from "./engineMode";
import { hydrateAutopilotLock } from "./autopilotLock";
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
import { startSessionAlerts } from "./sessionAlerts";
import { signalStore } from "./signalStore";
import { positionStore } from "./positionStore";
import { tradeJournal } from "./tradeJournal";
import { deviceStore } from "./deviceStore";
import { riskState } from "./riskState";

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
  // signals/execution/journal/device/risk-guardian state from the DB (see
  // signalStore.ts/positionStore.ts/tradeJournal.ts/deviceStore.ts/riskState.ts's own
  // hydrate()) so a restart doesn't blank the dashboard, reopen hasExecuted()'s
  // idempotency window, lose the trade journal, silently unregister every phone from
  // push notifications, or silently clear a daily-loss halt/cooldown that's still
  // genuinely in effect (all five used to be pure in-memory or a local JSON file,
  // neither of which survives a Railway redeploy the way a real database does). No-ops
  // (and logs once) when DATABASE_URL isn't set -- the engine itself doesn't wait on
  // this, since the first real signal/execution is always much further off than a DB
  // round trip.
  Promise.all([signalStore.hydrate(), positionStore.hydrate(), tradeJournal.hydrate(), deviceStore.hydrate(), riskState.hydrate()]).catch(
    (error: unknown) => {
      console.error("[market] failed to hydrate signal/execution/journal/device/risk-state history from the database:", error);
    }
  );

  // Fire-and-forget, same reasoning as above -- if this restart silently dropped engine
  // mode out of LIVE/DEMO back to its safe ANALYSIS default (see engineMode.ts), sends a
  // push notification rather than that only being discoverable by chance.
  checkEngineModeAfterRestart().catch((error: unknown) => {
    console.error("[market] failed to check engine mode across restart:", error);
  });

  // Fire-and-forget, same posture as every hydrate above -- restores whatever
  // lock/unlock state was last persisted, so a Railway redeploy doesn't silently drop
  // the operator's own autopilot lock back to unlocked (see autopilotLock.ts). Engine
  // mode's own unconditional reset to ANALYSIS on every restart (just above) already
  // blocks all auto-execution until a human manually re-enables DEMO/LIVE, which is far
  // slower than this DB round trip -- so this can't be raced in practice.
  hydrateAutopilotLock().catch((error: unknown) => {
    console.error("[market] failed to hydrate autopilot lock:", error);
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
  startSessionAlerts();
}
