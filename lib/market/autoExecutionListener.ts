import { eventBus } from "./eventBus";
import { attemptExecution } from "./executionEngine";
import { autoExecutionAccount, getEngineMode } from "./engineMode";
import { getAccountInformation } from "./metaApiConnection";
import { requiresAcknowledgement, riskState } from "./riskState";
import { loadExecutionConfig } from "./executionConfig";

let started = false;

/**
 * The ONLY place a signal can auto-execute without a manual click. Subscribes to the
 * same eventBus "signal" events the SSE stream already consumes -- a second subscriber,
 * not a change to signalEngine.ts, which stays a pure, side-effect-free function.
 *
 * Checks engine mode fresh on every event (never cached) -- mode can only reach "live"
 * via an explicit, server-validated confirmation (engineMode.ts), and this listener
 * never sets it, only reads it.
 *
 * Deliberately ignores signal.source === "tradingview": that source already has its own
 * dedicated, always-live execution path (the webhook route calls attemptExecution
 * directly, unconditionally, regardless of engine mode). Reacting to it here too would
 * risk auto-firing a TradingView alert against the demo account as a side effect of
 * whatever engine mode happens to be selected -- behavior that integration was never
 * designed for.
 *
 * source === "mean_reversion" (rangeEngine.ts) additionally requires
 * executionConfig.ts's rangeEngineEnabled for the target account -- that engine has no
 * backtest history yet, so it ships detection-only (visible on the dashboard, never
 * executed) until explicitly turned on.
 */
export function startAutoExecutionListener(): void {
  if (started) return;
  started = true;

  eventBus.subscribe((event) => {
    if (event.type !== "signal") return;
    if (event.signal.source !== "smc" && event.signal.source !== "mean_reversion") return;

    const accountKey = autoExecutionAccount(getEngineMode());
    if (!accountKey) return; // ANALYSIS: no-op

    if (event.signal.source === "mean_reversion" && !loadExecutionConfig(accountKey).rangeEngineEnabled) return;

    // A halt/cooldown that has since cleared on its own (day rollover, cooldown timer)
    // still blocks auto-execution here until a human explicitly acknowledges it (see
    // riskState.ts's own doc comment) -- manual confirm-mode execution is unaffected,
    // it already has a human reviewing every trade via the proposal/approve flow.
    const equity = getAccountInformation(accountKey)?.equity ?? 0;
    if (requiresAcknowledgement(riskState.current(Date.now(), equity, accountKey))) return;

    attemptExecution(event.signal, accountKey).catch((error: unknown) => {
      console.error(`[auto-execution] error executing ${event.signal.pair} ${event.signal.id} (${accountKey}):`, error);
    });
  });
}
