import type { Candle } from "../types";
import { calculateAtr } from "./atr";

export interface SupertrendPoint {
  value: number;
  /** null before enough candles exist for ATR to warm up (matches every other
   * indicator's NaN-before-warmup convention, just string-typed since trend isn't a
   * number). */
  trend: "up" | "down" | null;
}

/**
 * Standard ATR-band-flip Supertrend (Olivier Seban's original formula, the same one
 * every major charting platform implements), computed purely from past+current closed
 * candles -- never the still-forming one, matching every other indicator in this
 * codebase and evaluateSignal's own barJustClosed guarantee. Non-repainting BY
 * CONSTRUCTION, not by assumption: each point is a pure function of `candles[0..i]`,
 * never anything after it. Proven, not just claimed -- see supertrend.test.ts's
 * "appending future candles never changes a past value" case, the TypeScript
 * equivalent of manually checking Strategy Tester for repaint behavior on a
 * third-party MQL indicator (which this deliberately avoids depending on).
 */
export function calculateSupertrend(candles: Candle[], period = 10, multiplier = 3): SupertrendPoint[] {
  const atr = calculateAtr(candles, period);
  const result: SupertrendPoint[] = candles.map(() => ({ value: NaN, trend: null }));

  let finalUpperBand = NaN;
  let finalLowerBand = NaN;
  let trend: "up" | "down" | null = null;

  for (let i = 0; i < candles.length; i++) {
    if (Number.isNaN(atr[i])) continue;

    const candle = candles[i];
    const mid = (candle.high + candle.low) / 2;
    const basicUpperBand = mid + multiplier * atr[i];
    const basicLowerBand = mid - multiplier * atr[i];

    if (trend === null) {
      // First bar with a valid ATR -- seed the bands and pick a starting trend from the
      // close's position relative to the midpoint, same as every reference
      // implementation's initialization step.
      finalUpperBand = basicUpperBand;
      finalLowerBand = basicLowerBand;
      trend = candle.close >= mid ? "up" : "down";
    } else {
      // Bands only ever tighten toward price (never widen back out) unless the prior
      // close broke through them -- the "trailing stop" behavior that makes Supertrend
      // a trend indicator rather than a raw volatility band.
      const prevClose = candles[i - 1].close;
      finalUpperBand = basicUpperBand < finalUpperBand || prevClose > finalUpperBand ? basicUpperBand : finalUpperBand;
      finalLowerBand = basicLowerBand > finalLowerBand || prevClose < finalLowerBand ? basicLowerBand : finalLowerBand;

      if (trend === "up" && candle.close < finalLowerBand) trend = "down";
      else if (trend === "down" && candle.close > finalUpperBand) trend = "up";
    }

    result[i] = { value: trend === "up" ? finalLowerBand : finalUpperBand, trend };
  }

  return result;
}
