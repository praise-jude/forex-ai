import type { Candle } from "../types";
import { calculateEma } from "./ema";

/**
 * EMA50/EMA200 relationship on whatever candle array is passed in -- shared by
 * signalEngine.ts's D1/H4/H1 multi-timeframe agreement pre-gate (unchanged call site)
 * and signerB.ts's own-timeframe independent trend read. Distinct from the stricter
 * 4-EMA stack scored in confidenceScore.ts's direction dimension -- that's SMC's own
 * internal trend-quality check, this is a plain two-line read reused wherever "what
 * does EMA50/200 say" is asked.
 */
export function emaTrendDirection(candles: Candle[]): "bullish" | "bearish" | "neutral" {
  if (candles.length < 200) return "neutral";
  const closes = candles.map((c) => c.close);
  const index = candles.length - 1;
  const fast = calculateEma(closes, 50)[index];
  const slow = calculateEma(closes, 200)[index];
  if (Number.isNaN(fast) || Number.isNaN(slow)) return "neutral";
  if (fast > slow) return "bullish";
  if (fast < slow) return "bearish";
  return "neutral";
}
