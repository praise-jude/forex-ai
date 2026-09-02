import type { Candle } from "./types";
import { calculateAtr } from "./indicators/atr";

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
