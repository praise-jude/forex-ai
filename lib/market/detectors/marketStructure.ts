import type { SwingPoint } from "../types";

/**
 * Higher-high + higher-low (or the mirror) across the last two swing highs/lows.
 * Reuses whatever swings the caller already computed via detectSwingPoints — no new
 * detection pass needed.
 */
export function marketStructureTrend(swings: SwingPoint[]): "bullish" | "bearish" | "neutral" {
  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");
  if (highs.length < 2 || lows.length < 2) return "neutral";

  const [prevHigh, lastHigh] = highs.slice(-2);
  const [prevLow, lastLow] = lows.slice(-2);

  if (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price) return "bullish";
  if (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price) return "bearish";
  return "neutral";
}
