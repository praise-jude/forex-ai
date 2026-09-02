import { randomUUID } from "node:crypto";
import type { Pair, Signal, Timeframe } from "./types";
import { getActiveSession } from "./sessions";

export interface ManualSignalInput {
  pair: Pair;
  direction: "long" | "short";
  /** The real current market-order fill price (ask for long, bid for short) -- resolved
   * by the caller from priceStore, never a price the operator types in. This app only
   * places market orders (see metaApiConnection.ts's placeMarketOrder), so there is no
   * real "entry" for a hand-entered trade other than whatever the market is doing right
   * now. */
  entry: number;
  stopLoss: number;
  takeProfit: number;
  takeProfit2?: number;
}

export type BuildManualSignalResult = { signal: Signal } | { error: string };

// No real timeframe concept for a hand-entered trade -- picked purely as a stable
// bookkeeping value (hasAdverseOpenPosition and the trade journal both key on
// pair+timeframe+direction), same reasoning tradingViewWebhook.ts's own
// DEFAULT_TIMEFRAME uses.
const MANUAL_TIMEFRAME: Timeframe = "15m";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Builds a Signal from the operator's own hand-picked pair/direction/stopLoss/takeProfit
 * -- for placing a trade the human decided on directly, independent of whether the
 * SMC/range engines currently see a qualifying setup. Same placeholder-field pattern as
 * tradingViewWebhook.ts's parseTradingViewAlert (source "manual" instead of
 * "tradingview"): confidence/directionScore/entryScore/tier are fixed, not a real
 * weighted score, and every reading this app has no way to derive for a hand-entered
 * trade (adx/rsi/signerB/etc.) is honestly NaN/"unavailable", never fabricated. Still
 * goes through attemptExecution's full, unmodified risk-checked path afterward (see
 * app/api/signals/manual/route.ts) -- this only replaces the SMC/range engine's own "is
 * this a good setup" judgment with the human's; it does not bypass sizing, correlation,
 * daily-loss, spread, or price-drift checks.
 */
export function buildManualSignal(input: ManualSignalInput, now: number): BuildManualSignalResult {
  const { pair, direction, entry, stopLoss, takeProfit } = input;
  if (!isFiniteNumber(entry)) return { error: "no live price available for this pair yet -- try again shortly" };
  if (!isFiniteNumber(stopLoss)) return { error: "stopLoss must be a number" };
  if (!isFiniteNumber(takeProfit)) return { error: "takeProfit must be a number" };

  const takeProfit2 = input.takeProfit2 ?? takeProfit;
  if (!isFiniteNumber(takeProfit2)) return { error: "takeProfit2 must be a number if provided" };

  // A misconfigured manual trade must never place a geometrically broken order -- same
  // check tradingViewWebhook.ts applies to its own user-supplied prices.
  const structurallySound =
    direction === "long" ? stopLoss < entry && entry < takeProfit : stopLoss > entry && entry > takeProfit;
  if (!structurallySound) {
    return {
      error: `stopLoss/takeProfit are on the wrong side of the current price for a ${direction === "long" ? "BUY" : "SELL"}`,
    };
  }

  const signal: Signal = {
    id: `manual-${randomUUID()}`,
    source: "manual",
    pair,
    direction,
    entry,
    stopLoss,
    takeProfit,
    takeProfit2,
    riskReward: Math.abs(takeProfit - entry) / Math.abs(entry - stopLoss),
    // Placeholder values -- see UNSCORED_SOURCE_LABEL's own doc comment. Fixed at "buy"
    // (never "watch") so this doesn't trip executionEngine.ts's watch-tier guard;
    // confluences stays empty since none of the SMC confluence types describe what
    // actually triggered a hand-entered trade.
    confidence: 100,
    directionScore: 100,
    entryScore: 100,
    // No candle-derived computation behind a hand-entered trade -- honestly NaN, never
    // fabricated as a real reading.
    adx: NaN,
    rsi: NaN,
    tier: "buy",
    confluences: [],
    session: getActiveSession(now),
    timeframe: MANUAL_TIMEFRAME,
    createdAt: now,
    signerBDirection: "unavailable",
    signerBConfidence: 0,
    signerBEmaTrend: "unavailable",
    rsiDivergence: "unavailable",
    supertrendTrend: "unavailable",
    usdStrengthStatus: "unavailable",
    newsStatus: "unavailable",
  };

  return { signal };
}
