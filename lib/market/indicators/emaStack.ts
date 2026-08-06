import type { Candle } from "../types";
import { calculateEma } from "./ema";

const STACK_PERIODS = [20, 50, 100, 200];

/** EMA20 > EMA50 > EMA100 > EMA200 with price above EMA20 (or the mirror for short). */
export function isEmaStackAligned(candles: Candle[], direction: "long" | "short"): boolean {
  const closes = candles.map((c) => c.close);
  const index = candles.length - 1;
  const [ema20, ema50, ema100, ema200] = STACK_PERIODS.map((period) => calculateEma(closes, period)[index]);

  if ([ema20, ema50, ema100, ema200].some((v) => Number.isNaN(v))) return false;

  const lastClose = candles[index]?.close;
  if (direction === "long") return ema20 > ema50 && ema50 > ema100 && ema100 > ema200 && lastClose > ema20;
  return ema20 < ema50 && ema50 < ema100 && ema100 < ema200 && lastClose < ema20;
}
