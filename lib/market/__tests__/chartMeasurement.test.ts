import { describe, expect, it } from "vitest";
import { measureCandleRange, describeMeasurement } from "../chartMeasurement";
import type { Candle } from "../types";

function candle(time: number, close: number): Candle {
  return { time, open: close, high: close, low: close, close, tickVolume: 100 };
}

const FIFTEEN_MIN = 15 * 60 * 1000;

describe("measureCandleRange", () => {
  it("reports an up move when the later candle closed higher", () => {
    const a = candle(0, 1.085);
    const b = candle(FIFTEEN_MIN * 4, 1.089); // +40 pips on EUR/USD (pip = 0.0001)
    const result = measureCandleRange(a, b, "EUR/USD", "15m");
    expect(result.direction).toBe("up");
    expect(result.priceDelta).toBeCloseTo(0.004, 6);
    expect(result.pips).toBeCloseTo(40, 5);
    expect(result.candleCount).toBe(5); // inclusive of both endpoints, 4 bars apart
  });

  it("reports a down move when the later candle closed lower", () => {
    const a = candle(0, 1.089);
    const b = candle(FIFTEEN_MIN, 1.085);
    const result = measureCandleRange(a, b, "EUR/USD", "15m");
    expect(result.direction).toBe("down");
    expect(result.priceDelta).toBeLessThan(0);
    expect(result.pips).toBeCloseTo(40, 5);
  });

  it("reports flat when both candles closed at the same price", () => {
    const a = candle(0, 1.085);
    const b = candle(FIFTEEN_MIN, 1.085);
    const result = measureCandleRange(a, b, "EUR/USD", "15m");
    expect(result.direction).toBe("flat");
    expect(result.pips).toBe(0);
  });

  it("is order-independent -- clicking the later candle first gives the same result", () => {
    const earlier = candle(0, 1.085);
    const later = candle(FIFTEEN_MIN * 4, 1.089);
    const clickedForward = measureCandleRange(earlier, later, "EUR/USD", "15m");
    const clickedBackward = measureCandleRange(later, earlier, "EUR/USD", "15m");
    expect(clickedBackward).toEqual(clickedForward);
  });
});

describe("describeMeasurement", () => {
  it("says a BUY would have won on an up move", () => {
    const result = measureCandleRange(candle(0, 1.085), candle(FIFTEEN_MIN, 1.089), "EUR/USD", "15m");
    expect(describeMeasurement(result)).toContain("BUY would have won");
  });

  it("says a SELL would have won on a down move", () => {
    const result = measureCandleRange(candle(0, 1.089), candle(FIFTEEN_MIN, 1.085), "EUR/USD", "15m");
    expect(describeMeasurement(result)).toContain("SELL would have won");
  });

  it("reports FLAT with no buy/sell verdict when there's no net move", () => {
    const result = measureCandleRange(candle(0, 1.085), candle(FIFTEEN_MIN, 1.085), "EUR/USD", "15m");
    const text = describeMeasurement(result);
    expect(text).toContain("FLAT");
    expect(text).not.toContain("BUY");
    expect(text).not.toContain("SELL");
  });
});
