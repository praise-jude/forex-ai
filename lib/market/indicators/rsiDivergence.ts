import type { Candle, SwingPoint } from "../types";

const DEFAULT_LOOKBACK_CANDLES = 50;

/**
 * Bullish: price's two most recent swing lows (within `lookbackCandles` of the last
 * candle) make a LOWER low while RSI at those same candle indices makes a HIGHER low
 * -- momentum fading even as price pushes further down, a classic reversal tell.
 * Bearish is the mirror on swing highs. Reuses the swing points SMC's own sweep/
 * structure detection already computed (detectSwingPoints in detectors/swings.ts) --
 * no separate swing-finding logic, and non-repainting for the same reason SMC's own
 * detection is: those swings are already derived from closed-candle structure only.
 * Returns null (never fabricated) when there aren't two qualifying swings in the
 * window, or when RSI is NaN (unwarmed) at either point.
 */
export function detectRsiDivergence(
  candles: Candle[],
  rsiSeries: number[],
  swings: SwingPoint[],
  lookbackCandles: number = DEFAULT_LOOKBACK_CANDLES
): "bullish" | "bearish" | null {
  const lastIndex = candles.length - 1;
  const withinLookback = (s: SwingPoint) => s.index >= lastIndex - lookbackCandles && s.index <= lastIndex;

  const lows = swings.filter((s) => s.type === "low" && withinLookback(s)).sort((a, b) => a.index - b.index);
  if (lows.length >= 2) {
    const [prevLow, lastLow] = lows.slice(-2);
    const prevRsi = rsiSeries[prevLow.index];
    const lastRsi = rsiSeries[lastLow.index];
    if (!Number.isNaN(prevRsi) && !Number.isNaN(lastRsi) && lastLow.price < prevLow.price && lastRsi > prevRsi) {
      return "bullish";
    }
  }

  const highs = swings.filter((s) => s.type === "high" && withinLookback(s)).sort((a, b) => a.index - b.index);
  if (highs.length >= 2) {
    const [prevHigh, lastHigh] = highs.slice(-2);
    const prevRsi = rsiSeries[prevHigh.index];
    const lastRsi = rsiSeries[lastHigh.index];
    if (!Number.isNaN(prevRsi) && !Number.isNaN(lastRsi) && lastHigh.price > prevHigh.price && lastRsi < prevRsi) {
      return "bearish";
    }
  }

  return null;
}
