import type { Candle, Pair, Timeframe } from "./types";
import { pipSize } from "./symbols";
import { TIMEFRAME_MS } from "./timeframes";

export interface MeasurementResult {
  fromTime: number;
  toTime: number;
  fromClose: number;
  toClose: number;
  direction: "up" | "down" | "flat";
  /** Signed: toClose - fromClose. */
  priceDelta: number;
  /** Unsigned magnitude, in pips. */
  pips: number;
  /** Signed percentage change from fromClose to toClose. */
  pctChange: number;
  /** Candles from `from` through `to`, inclusive, at the chart's own timeframe. */
  candleCount: number;
}

/**
 * Purely retrospective: reports what a price range that has ALREADY happened actually
 * did -- direction, magnitude, how long it took -- never a prediction. Order-independent
 * (whichever of the two candles the operator clicked first, the earlier one is always
 * treated as `from`) so the readout reads the same regardless of click order.
 */
export function measureCandleRange(a: Candle, b: Candle, pair: Pair, timeframe: Timeframe): MeasurementResult {
  const [from, to] = a.time <= b.time ? [a, b] : [b, a];
  const priceDelta = to.close - from.close;
  const direction: MeasurementResult["direction"] = priceDelta > 0 ? "up" : priceDelta < 0 ? "down" : "flat";
  const pips = Math.abs(priceDelta) / pipSize(pair);
  const pctChange = (priceDelta / from.close) * 100;
  const barMs = TIMEFRAME_MS[timeframe];
  const candleCount = barMs > 0 ? Math.round((to.time - from.time) / barMs) + 1 : 1;
  return { fromTime: from.time, toTime: to.time, fromClose: from.close, toClose: to.close, direction, priceDelta, pips, pctChange, candleCount };
}

/** One-line summary for the chart's floating readout -- the only place this app ever
 * says "BUY would have won"/"SELL would have won", and only about a range that has
 * already closed, never as a forward-looking claim. */
export function describeMeasurement(result: MeasurementResult): string {
  const sign = result.priceDelta >= 0 ? "+" : "-";
  const pipsText = `${sign}${result.pips.toFixed(1)} pips (${sign}${Math.abs(result.pctChange).toFixed(2)}%)`;
  const candlesText = `${result.candleCount} candle${result.candleCount === 1 ? "" : "s"}`;
  if (result.direction === "up") return `UP ${pipsText} over ${candlesText} -- a BUY would have won here`;
  if (result.direction === "down") return `DOWN ${pipsText} over ${candlesText} -- a SELL would have won here`;
  return `FLAT -- no net move over ${candlesText}`;
}
