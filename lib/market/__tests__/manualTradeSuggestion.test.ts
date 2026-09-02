import { describe, expect, it } from "vitest";
import { suggestManualTradeLevels } from "../manualTradeSuggestion";
import type { Candle } from "../types";

// 20 candles with a steady, real true-range so calculateAtr (period 14) has enough
// history to produce a real, non-NaN ATR -- alternating high/low around a flat close so
// the true range is driven by the wicks, not by trending closes (keeps entry a clean,
// known distance from the resulting ATR-derived levels).
function buildCandles(): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < 20; i++) {
    candles.push({ time: i * 60_000, open: 1.1, high: 1.101, low: 1.099, close: 1.1, tickVolume: 100 });
  }
  return candles;
}

describe("suggestManualTradeLevels", () => {
  it("returns null when there isn't enough candle history for a real ATR", () => {
    const result = suggestManualTradeLevels([], "long", 1.1);
    expect(result).toBeNull();
  });

  it("returns null for a non-finite entry", () => {
    const result = suggestManualTradeLevels(buildCandles(), "long", NaN);
    expect(result).toBeNull();
  });

  it("places stopLoss below and takeProfit above entry for a long", () => {
    const result = suggestManualTradeLevels(buildCandles(), "long", 1.1);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.stopLoss).toBeLessThan(1.1);
    expect(result.takeProfit).toBeGreaterThan(1.1);
  });

  it("places stopLoss above and takeProfit below entry for a short", () => {
    const result = suggestManualTradeLevels(buildCandles(), "short", 1.1);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.stopLoss).toBeGreaterThan(1.1);
    expect(result.takeProfit).toBeLessThan(1.1);
  });

  it("sizes the take-profit distance at exactly 2x the stop distance", () => {
    const result = suggestManualTradeLevels(buildCandles(), "long", 1.1);
    expect(result).not.toBeNull();
    if (!result) return;
    const stopDistance = 1.1 - result.stopLoss;
    const takeProfitDistance = result.takeProfit - 1.1;
    expect(takeProfitDistance).toBeCloseTo(stopDistance * 2, 6);
  });
});
