import { describe, expect, it } from "vitest";
import { calculateSupertrend } from "../supertrend";
import { candle } from "../../detectors/__tests__/fixtures";

function uptrendCandles(count: number) {
  // Steady 2-point-per-bar advance with a tight 1-point range on each side -- price
  // moves well beyond what a small ATR-scaled band can catch up to, so the trend should
  // lock "up" and the band should trail below price once warmed up.
  return Array.from({ length: count }, (_, i) => {
    const open = 100 + 2 * i;
    const close = open + 2;
    return candle(i, open, close + 1, open - 1, close);
  });
}

function downtrendCandles(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const open = 200 - 2 * i;
    const close = open - 2;
    return candle(i, open, open + 1, close - 1, close);
  });
}

describe("calculateSupertrend", () => {
  it("is null/NaN before ATR has enough candles to warm up", () => {
    const candles = uptrendCandles(5);
    const result = calculateSupertrend(candles, 10, 3);
    expect(result.every((p) => p.trend === null && Number.isNaN(p.value))).toBe(true);
  });

  it("settles into an up trend, trailing below price, on a steady uptrend", () => {
    const candles = uptrendCandles(30);
    const result = calculateSupertrend(candles, 10, 3);
    const last = result[result.length - 1];
    expect(last.trend).toBe("up");
    expect(last.value).toBeLessThan(candles[candles.length - 1].close);
  });

  it("settles into a down trend, trailing above price, on a steady downtrend", () => {
    const candles = downtrendCandles(30);
    const result = calculateSupertrend(candles, 10, 3);
    const last = result[result.length - 1];
    expect(last.trend).toBe("down");
    expect(last.value).toBeGreaterThan(candles[candles.length - 1].close);
  });

  it("never repaints -- appending future candles never changes a past-computed value", () => {
    // The TypeScript equivalent of manually checking Strategy Tester for repaint
    // behavior: each point must be a pure function of candles up to and including its
    // own index, never anything after it.
    const base = uptrendCandles(25);
    const extended = [...base, ...uptrendCandles(10).map((c, i) => candle(25 + i, c.open + 50, c.high + 50, c.low + 50, c.close + 50))];

    const resultBase = calculateSupertrend(base, 10, 3);
    const resultExtended = calculateSupertrend(extended, 10, 3);

    expect(resultExtended.slice(0, base.length)).toEqual(resultBase);
  });

  it("never repaints on a downtrend either, including through a trend flip", () => {
    const base = [...downtrendCandles(20), ...uptrendCandles(10).map((c, i) => candle(20 + i, c.open, c.high, c.low, c.close))];
    const extended = [...base, ...uptrendCandles(15).map((c, i) => candle(30 + i, c.open + 20, c.high + 20, c.low + 20, c.close + 20))];

    const resultBase = calculateSupertrend(base, 10, 3);
    const resultExtended = calculateSupertrend(extended, 10, 3);

    expect(resultExtended.slice(0, base.length)).toEqual(resultBase);
  });
});
