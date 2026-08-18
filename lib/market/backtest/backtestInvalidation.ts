import type { ExecutedTrade, Signal } from "../types";
import { findInvalidatedTrades } from "../positionInvalidation";
import type { BacktestBarResult } from "./backtestEngine";

/** Synthetic "still open" ExecutedTrade representing one fired backtest signal -- just
 * enough shape for findInvalidatedTrades' pair/timeframe/direction matching, reused
 * as-is (not reimplemented) so backtest invalidation can never drift from live's real
 * positionInvalidation.ts behavior. brokerPositionId is set to the signal's own id
 * purely to satisfy findInvalidatedTrades' presence check -- never a real broker id. */
function toPseudoTrade(signal: Signal): ExecutedTrade {
  return {
    id: signal.id,
    signalId: signal.id,
    account: "live",
    pair: signal.pair,
    timeframe: signal.timeframe,
    direction: signal.direction,
    requestedLots: 0,
    requestedEntry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    takeProfit2: signal.takeProfit2,
    status: "filled",
    brokerPositionId: signal.id,
    riskPct: 0,
    attemptedAt: signal.createdAt,
  };
}

/**
 * Post-processes one pair+timeframe's chronologically-ordered backtest bars (as
 * produced by runBacktest -- one call per pair, a single timeframe for the whole job,
 * see backtestRunner.ts) so a later opposite-direction signal truncates an earlier
 * still-open signal's outcome to its own fire time/price, exactly mirroring what live's
 * positionInvalidation.ts does the instant a fresh opposite signal fires. Reuses
 * findInvalidatedTrades directly rather than reimplementing its matching rules, so the
 * two can never silently drift apart.
 *
 * The truncated exit price is the invalidating signal's own entry -- the best real,
 * contemporaneous price available at that bar without new plumbing (live closes at the
 * actual current market price via closePosition, which this approximates). Does not
 * mutate the input array; returns a new array with adjusted `outcome`s only on entries
 * that actually got truncated.
 */
export function applyEarlyInvalidation(results: BacktestBarResult[]): BacktestBarResult[] {
  const output = results.map((r) => ({ ...r }));
  // Pseudo-positions still open as of the bar currently being processed, in fired order.
  const open: { index: number; signal: Signal }[] = [];

  for (let i = 0; i < output.length; i++) {
    const result = output[i];
    if (result.evaluation.status !== "signal" || !result.outcome) continue;
    const { signal } = result.evaluation;

    // Drop any pseudo-position whose own (natural or already-truncated) exit already
    // happened at or before this bar -- it's no longer open to be invalidated here.
    for (let j = open.length - 1; j >= 0; j--) {
      const openOutcome = output[open[j].index].outcome!;
      if (openOutcome.exitTime <= result.barTime) open.splice(j, 1);
    }

    const openTrades = open.map((o) => toPseudoTrade(o.signal));
    const invalidated = findInvalidatedTrades(signal, openTrades);
    for (const trade of invalidated) {
      const openEntry = open.find((o) => o.signal.id === trade.signalId);
      if (!openEntry) continue;

      const target = output[openEntry.index];
      const targetEvaluation = target.evaluation as { status: "signal"; signal: Signal };
      const targetSignal = targetEvaluation.signal;
      const stopDistance = Math.abs(targetSignal.entry - targetSignal.stopLoss);
      const isLong = targetSignal.direction === "long";
      const exitPrice = signal.entry;
      const rMultiple =
        stopDistance > 0 ? (isLong ? (exitPrice - targetSignal.entry) / stopDistance : (targetSignal.entry - exitPrice) / stopDistance) : 0;

      target.outcome = { exitPrice, exitTime: signal.createdAt, reason: "invalidation", rMultiple, tp2Reached: false };
    }

    open.push({ index: i, signal });
  }

  return output;
}
