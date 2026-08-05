import type { Candle, SwingPoint } from "../types";

/**
 * Fractal swing detection: a candle is a swing high/low when its high/low is
 * strictly more extreme than `lookback` candles on each side.
 */
export function detectSwingPoints(candles: Candle[], lookback = 2): SwingPoint[] {
  const swings: SwingPoint[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const candle = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let offset = 1; offset <= lookback; offset++) {
      if (candles[i - offset].high >= candle.high || candles[i + offset].high >= candle.high) {
        isHigh = false;
      }
      if (candles[i - offset].low <= candle.low || candles[i + offset].low <= candle.low) {
        isLow = false;
      }
    }

    if (isHigh) swings.push({ index: i, time: candle.time, price: candle.high, type: "high" });
    if (isLow) swings.push({ index: i, time: candle.time, price: candle.low, type: "low" });
  }

  return swings;
}
