import type { Candle, Pair } from "./types";
import { calculateAtr } from "./indicators/atr";
import { formatPrice } from "./format";

export interface ManualTradeSuggestion {
  stopLoss: number;
  takeProfit: number;
}

// A hand-entered trade has no SMC zone/structure to anchor a stop to (unlike
// signalEngine.ts's sweep-relative stopLoss) -- ATR is the only honest, real
// distance available for a pair the operator picked with no detected setup. 1.5x ATR
// is a wider, more conservative multiple than signalEngine.ts's own 0.25x ATR buffer
// (that buffer sits just past an already-identified structural level; this has no
// structural level to sit past, so the ATR itself has to carry the whole distance).
const STOP_ATR_MULTIPLE = 1.5;
// Matches signalEngine.ts's own FALLBACK_RISK_REWARD -- the same ratio this app
// already falls back to whenever there's no closer structural target to aim at.
const SUGGESTED_RISK_REWARD = 2;

/**
 * A starting-point stop-loss/take-profit for a manual trade, computed from this pair's
 * own recent volatility (ATR) -- never a claim that this is where the market will
 * actually turn, just a real, non-arbitrary distance instead of asking the operator to
 * type a number out of thin air. Always shown as editable in the UI, never auto-
 * submitted without the operator seeing and being able to change it.
 */
export function suggestManualTradeLevels(candles: Candle[], direction: "long" | "short", entry: number): ManualTradeSuggestion | null {
  if (!Number.isFinite(entry)) return null;
  const atrSeries = calculateAtr(candles);
  const atr = atrSeries[atrSeries.length - 1];
  if (!Number.isFinite(atr) || atr <= 0) return null;

  const stopDistance = atr * STOP_ATR_MULTIPLE;
  const takeProfitDistance = stopDistance * SUGGESTED_RISK_REWARD;

  return direction === "long"
    ? { stopLoss: entry - stopDistance, takeProfit: entry + takeProfitDistance }
    : { stopLoss: entry + stopDistance, takeProfit: entry - takeProfitDistance };
}

export interface RangePerformance {
  count: number;
  winRate: number;
  profitFactor: number | null;
}

export type RangePerformanceTone = "warning" | "neutral" | "positive";

export interface RangePerformanceNarrative {
  tone: RangePerformanceTone;
  text: string;
}

// Below 1.0, gross losses genuinely exceed gross profit in this regime, regardless of
// how high the win rate reads -- this is the real "many small wins, one big loss" trap
// a direct journal review found on 2026-09-08 (every significant loss on record landed
// on a range-tagged trade). 1.0-1.5 is real but thin: wins cover losses with little
// room to spare. Both thresholds only ever affect the WORDING below, never whether the
// banner shows or blocks anything -- see ManualTradeWidget.tsx's own doc comment.
const LOSING_PROFIT_FACTOR = 1.0;
const MARGINAL_PROFIT_FACTOR = 1.5;

/**
 * Turns the operator's own range-regime journal stats into an honest sentence -- fixes
 * a real bug where ManualTradeWidget.tsx used to hardcode "occasional losses... have
 * outweighed the many small wins" unconditionally, for every profitFactor value,
 * because that was true when the warning was first written (2026-09-08) but the text
 * was never made to actually depend on the number. That left the same "losses have
 * outweighed wins" claim rendering next to a profitFactor like 17.77 -- a hugely
 * profitable regime, the opposite of what the sentence said. Never a block either way
 * (the operator explicitly wants manual trading kept fully available); this only makes
 * sure the sentence next to the real number agrees with it.
 */
export function describeRangePerformance(pair: Pair, performance: RangePerformance): RangePerformanceNarrative {
  const { count, winRate, profitFactor } = performance;
  const track = `${winRate.toFixed(0)}% win rate across ${count} trades`;
  const intro = `${pair} is currently in a range regime. Your own history trading range conditions:`;

  if (profitFactor === null) {
    return {
      tone: "neutral",
      text: `${intro} ${track}, with no losing range-regime trades on record yet to measure a profit factor against.`,
    };
  }
  if (profitFactor < LOSING_PROFIT_FACTOR) {
    return {
      tone: "warning",
      text: `${intro} ${track}, but a ${profitFactor.toFixed(2)} profit factor -- occasional losses in this regime have outweighed the many small wins. Not a block, just the real number before you click.`,
    };
  }
  if (profitFactor < MARGINAL_PROFIT_FACTOR) {
    return {
      tone: "neutral",
      text: `${intro} ${track} and a ${profitFactor.toFixed(2)} profit factor -- roughly breaking even here once losses are weighed against the wins.`,
    };
  }
  return {
    tone: "positive",
    text: `${intro} ${track} and a ${profitFactor.toFixed(2)} profit factor -- this regime has actually been solidly profitable for you. Still the real number before you click, not a recommendation.`,
  };
}

/**
 * One plain-English sentence covering exactly what will happen at each price level --
 * for someone who wants to glance at the numbers and click, not read a chart. Pure
 * text only; never called anywhere that actually places or changes a trade.
 */
export function describeManualTradePlan(pair: Pair, direction: "long" | "short", entry: number, stopLoss: number, takeProfit: number): string {
  const action = direction === "long" ? "Buy" : "Sell";
  const worseWord = direction === "long" ? "falls" : "rises";
  const betterWord = direction === "long" ? "rises" : "falls";
  return (
    `${action} ${pair} now, around ${formatPrice(pair, entry)}. ` +
    `If price ${worseWord} to ${formatPrice(pair, stopLoss)}, this trade exits automatically to limit the loss. ` +
    `If price ${betterWord} to ${formatPrice(pair, takeProfit)}, this trade exits automatically to lock in the profit.`
  );
}
