import type { Candle } from "../types";

/** Compares candles[index]'s volume against the mean of the preceding `period` candles. */
export function isAboveAverageVolume(candles: Candle[], index: number, period = 20): boolean {
  if (index < period) return false;
  const window = candles.slice(index - period, index);
  const average = window.reduce((sum, c) => sum + c.tickVolume, 0) / period;
  return candles[index].tickVolume > average;
}
