import { ensureMetaApiConnection, isAccountConfigured } from "./metaApiConnection";
import { checkEngineModeAfterRestart, startEngineModeReminder } from "./engineMode";
import { startLiveModeRecovery } from "./liveModeRecovery";
import { startEvaluationLogPruning, startEvaluationHealthMonitor } from "./evaluationLog";
import { hydrateAutopilotLock } from "./autopilotLock";
import { hydrateEngineToggles } from "./engineToggles";
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
import { startHourlyActivitySummary } from "./hourlyActivitySummary";
import { startSessionAlerts } from "./sessionAlerts";
import { signalStore } from "./signalStore";
import { positionStore } from "./positionStore";
import { tradeJournal } from "./tradeJournal";
import { deviceStore } from "./deviceStore";
import { riskState } from "./riskState";
import { dealDedup } from "./dealDedup";

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

  // Reloads recent signals/execution/journal/device/risk-guardian/deal-dedup state from
  // the DB (see signalStore.ts/positionStore.ts/tradeJournal.ts/deviceStore.ts/
  // riskState.ts/dealDedup.ts's own hydrate()) so a restart doesn't blank the dashboard,
  // reopen hasExecuted()'s idempotency window, lose the trade journal, silently
  // unregister every phone from push notifications, silently clear a daily-loss halt/
  // cooldown that's still genuinely in effect, or reopen the redelivery window that let
  // the same closed deal get re-counted by riskState across a restart (all six used to
  // be pure in-memory or a local JSON file, neither of which survives a Railway redeploy
  // the way a real database does). No-ops (and logs once) when DATABASE_URL isn't set.
  // The connection/listener startup below is deliberately held until this resolves --
  // see that block's own doc comment for why (a real, confirmed riskState race).
  const dbHydration = Promise.all([
    signalStore.hydrate(),
    positionStore.hydrate(),
    tradeJournal.hydrate(),
    deviceStore.hydrate(),
    riskState.hydrate(),
    dealDedup.hydrate(),
  ]).catch((error: unknown) => {
    console.error("[market] failed to hydrate signal/execution/journal/device/risk-state/deal-dedup history from the database:", error);
  });

  // Real, confirmed incident (2026-09-12): riskState.current() creates a fresh
  // in-memory entry the FIRST time it's ever called for an account (see riskState.ts),
  // and hydrate()'s own restore loop deliberately skips any account already present in
  // memory (an operator's later, real change must never be silently overwritten by a
  // slow DB read arriving after it) -- so if anything reaches riskState.current() even
  // once before the hydration above resolves, whatever halt/cooldown/startOfDayEquity
  // was genuinely persisted from before this restart is discarded, permanently, for the
  // rest of the day. A real daily-loss halt vanished this exact way tonight. The three
  // things below are every path that can reach riskState.current()/setHaltedForToday
  // early in boot -- startLiveModeRecovery reads it directly, and both
  // ensureMetaApiConnection (via its own closing-deal listener, which can fire almost
  // immediately on reconnect for a position that closes right at boot) and
  // startAutoExecutionListener (the instant the connection starts delivering signals)
  // can reach it indirectly. Deliberately held behind the same hydration this whole
  // function already fires -- nothing else started below touches riskState at all.
  void dbHydration.then(() => {
    // checkEngineModeAfterRestart notifies/handles a DEMO restart itself and reports the
    // pre-restart mode; startLiveModeRecovery then decides, conditionally, whether to
    // re-arm a pre-restart LIVE mode (connection stable for minutes + equity + no risk
    // halt + not a restart loop) or leave it on ANALYSIS with its own notification -- see
    // liveModeRecovery.ts. It also records this boot for cross-restart loop detection
    // regardless of the previous mode.
    checkEngineModeAfterRestart()
      .then((previousMode) => startLiveModeRecovery(previousMode))
      .catch((error: unknown) => {
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
  });
  // Idempotent (intervalStarted guard inside) -- safe to call on every boot without
  // spawning a second interval. See engineMode.ts's own doc comment: the one-time
  // notification just above is easy to miss on a chaotic night; this is the recurring
  // backstop that keeps reminding until someone actually re-enables Demo/Live.
  startEngineModeReminder();
  // Idempotent, same pattern -- periodically prunes evaluation_log rows older than 30
  // days (see evaluationLog.ts) so this genuinely high-volume table never grows without
  // bound.
  startEvaluationLogPruning();
  // Idempotent, same pattern -- alerts if the signal engine itself goes quiet (see
  // evaluationLog.ts's own doc comment on why this is distinct from connection health).
  startEvaluationHealthMonitor();

  // Fire-and-forget, same posture as every hydrate above -- restores whatever
  // lock/unlock state was last persisted, so a Railway redeploy doesn't silently drop
  // the operator's own autopilot lock back to unlocked (see autopilotLock.ts). Engine
  // mode's own unconditional reset to ANALYSIS on every restart (just above) already
  // blocks all auto-execution until a human manually re-enables DEMO/LIVE, which is far
  // slower than this DB round trip -- so this can't be raced in practice.
  hydrateAutopilotLock().catch((error: unknown) => {
    console.error("[market] failed to hydrate autopilot lock:", error);
  });

  // Fire-and-forget, same posture as every hydrate above -- restores whatever Range
  // Engine/Trend Continuation on/off overrides were last set from the dashboard (see
  // engineToggles.ts), so a Railway redeploy doesn't silently drop an explicit operator
  // choice back to the env var default.
  hydrateEngineToggles().catch((error: unknown) => {
    console.error("[market] failed to hydrate engine toggles:", error);
  });

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
  startHourlyActivitySummary();
  startSessionAlerts();
}
