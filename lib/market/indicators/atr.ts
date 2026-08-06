import type { Candle } from "../types";

/** True range for candle i against the previous close (needs i >= 1). */
export function trueRange(candles: Candle[], i: number): number {
  const candle = candles[i];
  const prevClose = candles[i - 1].close;
  return Math.max(candle.high - candle.low, Math.abs(candle.high - prevClose), Math.abs(candle.low - prevClose));
}

/**
 * Wilder-smoothed average true range. Needs `period` true-range values (period + 1
 * candles) before the first value is meaningful — entries before that are NaN.
 */
export function calculateAtr(candles: Candle[], period = 14): number[] {
  const result = new Array<number>(candles.length).fill(NaN);
  if (candles.length < period + 1) return result;

  let atr = 0;
  for (let i = 1; i <= period; i++) atr += trueRange(candles, i);
  atr /= period;
  result[period] = atr;

  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + trueRange(candles, i)) / period;
    result[i] = atr;
  }

  return result;
}
