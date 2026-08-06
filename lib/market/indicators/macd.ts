import type { Candle } from "../types";
import { calculateEma } from "./ema";

export interface MacdResult {
  macdLine: number[];
  signalLine: number[];
}

export function calculateMacd(candles: Candle[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const closes = candles.map((c) => c.close);
  const emaFast = calculateEma(closes, fast);
  const emaSlow = calculateEma(closes, slow);

  const macdLine = closes.map((_, i) => (Number.isNaN(emaFast[i]) || Number.isNaN(emaSlow[i]) ? NaN : emaFast[i] - emaSlow[i]));

  // The MACD line itself starts with `slow - 1` NaN entries; feeding those into
  // calculateEma directly would seed its SMA window on NaNs. Slice them off first so
  // the signal line's own warm-up counts from the first real MACD value.
  const firstValidIndex = slow - 1;
  const signalOnValidRange = calculateEma(macdLine.slice(firstValidIndex), signalPeriod);
  const signalLine = new Array<number>(candles.length).fill(NaN);
  for (let i = 0; i < signalOnValidRange.length; i++) {
    signalLine[firstValidIndex + i] = signalOnValidRange[i];
  }

  return { macdLine, signalLine };
}
