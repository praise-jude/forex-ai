import type { ExecutedTrade, OpenPosition, Pair, Signal, Timeframe } from "./types";
import { eventBus } from "./eventBus";
import { attemptExecution } from "./executionEngine";
import { autoExecutionAccount, getEngineMode } from "./engineMode";
import { getAccountInformation, getOpenPositions } from "./metaApiConnection";
import { requiresAcknowledgement, riskState } from "./riskState";
import { loadExecutionConfig } from "./executionConfig";
import { positionStore } from "./positionStore";
import { isAutopilotLocked } from "./autopilotLock";
import { sendNotification } from "./pushNotifier";

let started = false;

// Purely informational -- narrates WHY a signal that otherwise qualified (already
// buy/strong_buy tier, already past the source/rangeEngine/lock/acknowledgement gates
// above) didn't end up auto-firing. Never itself changes whether a trade happens; see
// NotificationPrefs.autopilotBlocked's own doc comment for why the lock/kill-switch/
// engine-mode skips are deliberately NOT routed through this (self-evident, repetitive).
function notifyBlocked(signal: Signal, reason: string): void {
  void sendNotification({
    category: "signal_blocked",
    title: `JUDE AI — Signal held back: ${signal.pair}`,
    body: reason,
    data: { signalId: signal.id, pair: signal.pair },
  });
}

/**
 * Pure. True if this pair+timeframe already has an open, currently-losing position on
 * this account IN THE SAME DIRECTION as the incoming signal -- the autopilot's per-
 * pair/timeframe brake against piling more risk onto a trade that's already going
 * against it. Deliberately direction-scoped, not "any open trade on this pair+
 * timeframe": an OPPOSITE-direction signal must still pass straight through, since
 * that's the recovery path -- positionInvalidation.ts closes the losing trade and this
 * same event lets autoExecutionListener open the new, opposite-direction one, both
 * firing off the one fresh signal. Blocking here too would trap a losing position open
 * forever instead of letting it flip.
 *
 * Once the losing trade is actually closed (its own SL/TP, or that invalidation close),
 * this simply returns false again next time -- ordinary signal-driven auto-execution
 * resumes on its own, no separate re-arm step needed.
 *
 * Reads live broker P/L (OpenPosition.profit) rather than recomputing favorable/adverse
 * from raw price -- correct out of the box across pairs with different quote currencies
 * and pip values, matching positionManager.ts's own preference for broker-reported state
 * over re-derived math wherever it's available.
 */
export function hasAdverseOpenPosition(
  pair: Pair,
  timeframe: Timeframe,
  direction: "long" | "short",
  openTrades: ExecutedTrade[],
  openPositions: OpenPosition[]
): boolean {
  const positionsById = new Map(openPositions.map((position) => [position.id, position]));
  return openTrades.some((trade) => {
    if (trade.status !== "filled" || !trade.brokerPositionId) return false;
    if (trade.pair !== pair || trade.timeframe !== timeframe || trade.direction !== direction) return false;
    const live = positionsById.get(trade.brokerPositionId);
    return live !== undefined && live.profit < 0;
  });
}

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
 *
 * Reacts to a signal from any of the three signal engines (15m/30m/1h -- see
 * metaApiConnection.ts's SIGNAL_TIMEFRAMES) equally; nothing here narrows that set on
 * its own. hasAdverseOpenPosition below is what actually stops the autopilot from
 * piling onto a pair+timeframe that's already going against it, independent of which of
 * the three timeframes that is.
 */
export function startAutoExecutionListener(): void {
  if (started) return;
  started = true;

  eventBus.subscribe((event) => {
    if (event.type !== "signal") return;
    if (event.signal.source !== "smc" && event.signal.source !== "mean_reversion") return;

    // The operator's own manual master switch for the autopilot specifically -- see
    // autopilotLock.ts's doc comment for how this differs from the kill switch (which
    // also blocks manual clicks) and from engine mode (analysis/demo/live).
    if (isAutopilotLocked()) {
      console.log(`[auto-execution] skip ${event.signal.pair} ${event.signal.id}: autopilot is locked`);
      return;
    }

    const accountKey = autoExecutionAccount(getEngineMode());
    if (!accountKey) return; // ANALYSIS: no-op

    if (event.signal.source === "mean_reversion" && !loadExecutionConfig(accountKey).rangeEngineEnabled) return;

    // A halt/cooldown that has since cleared on its own (day rollover, cooldown timer)
    // still blocks auto-execution here until a human explicitly acknowledges it (see
    // riskState.ts's own doc comment) -- manual confirm-mode execution is unaffected,
    // it already has a human reviewing every trade via the proposal/approve flow.
    const equity = getAccountInformation(accountKey)?.equity ?? 0;
    if (requiresAcknowledgement(riskState.current(Date.now(), equity, accountKey))) return;

    // Per-pair/timeframe brake: don't add to a same-direction position that's already
    // carrying a loss -- wait for it to close (SL/TP, or an opposite-signal invalidation
    // close) before this same slot is allowed to auto-fire again in that direction. An
    // opposite-direction signal passes straight through -- see hasAdverseOpenPosition's
    // own doc comment for why that's the intended recovery/reversal path.
    const openTrades = positionStore.all().filter((trade) => trade.account === accountKey && trade.status === "filled");
    if (hasAdverseOpenPosition(event.signal.pair, event.signal.timeframe, event.signal.direction, openTrades, getOpenPositions(accountKey))) {
      const reason = `Your existing ${event.signal.direction} ${event.signal.pair} ${event.signal.timeframe} position is currently losing -- waiting for it to close before adding another in the same direction.`;
      console.log(`[auto-execution] skip ${event.signal.pair} ${event.signal.timeframe} ${event.signal.id} (${accountKey}): ${reason}`);
      notifyBlocked(event.signal, reason);
      return;
    }

    attemptExecution(event.signal, accountKey)
      .then((result) => {
        // "duplicate"/"rejected"/"filled" are either uninteresting (idempotency replay)
        // or already notified elsewhere (order_rejected in executionEngine.ts itself,
        // trade_opened on fill) -- only the two silent-by-default outcomes get a signal_
        // blocked push here.
        if (result.status === "blocked") notifyBlocked(event.signal, result.reason);
        if (result.status === "skipped_sizing") notifyBlocked(event.signal, result.reason);
      })
      .catch((error: unknown) => {
        console.error(`[auto-execution] error executing ${event.signal.pair} ${event.signal.id} (${accountKey}):`, error);
      });
  });
}
