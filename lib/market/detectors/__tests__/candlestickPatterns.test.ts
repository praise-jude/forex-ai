import { describe, expect, it } from "vitest";
import { detectCandlestickPattern } from "../candlestickPatterns";
import { candle } from "./fixtures";

describe("detectCandlestickPattern", () => {
  it("detects a bullish engulfing", () => {
    const prev = candle(0, 1.1, 1.11, 1.07, 1.08); // bearish
    const cur = candle(1, 1.07, 1.12, 1.06, 1.11); // engulfs prev's body
    expect(detectCandlestickPattern([prev, cur], 1)).toBe("bullish_engulfing");
  });

  it("detects a bearish engulfing", () => {
    const prev = candle(0, 1.08, 1.11, 1.07, 1.1); // bullish
    const cur = candle(1, 1.11, 1.12, 1.06, 1.07); // engulfs prev's body
    expect(detectCandlestickPattern([prev, cur], 1)).toBe("bearish_engulfing");
  });

  it("detects a bullish pin bar (small body, long lower wick)", () => {
    const c = candle(0, 1.095, 1.101, 1.05, 1.1);
    expect(detectCandlestickPattern([c], 0)).toBe("pin_bar_bullish");
  });

  it("detects a bearish pin bar (small body, long upper wick)", () => {
    const c = candle(0, 1.005, 1.05, 0.999, 1.0);
    expect(detectCandlestickPattern([c], 0)).toBe("pin_bar_bearish");
  });

  it("detects a morning star", () => {
    const a = candle(0, 1.2, 1.205, 1.145, 1.15); // strong bearish
    const b = candle(1, 1.14, 1.15, 1.135, 1.145); // small indecision
    const c = candle(2, 1.145, 1.195, 1.14, 1.19); // strong bullish, closes above a's midpoint (1.175)
    expect(detectCandlestickPattern([a, b, c], 2)).toBe("morning_star");
  });

  it("detects an evening star", () => {
    const a = candle(0, 1.15, 1.205, 1.145, 1.2); // strong bullish
    const b = candle(1, 1.205, 1.21, 1.195, 1.2); // small indecision
    const c = candle(2, 1.2, 1.205, 1.15, 1.155); // strong bearish, closes below a's midpoint (1.175)
    expect(detectCandlestickPattern([a, b, c], 2)).toBe("evening_star");
  });

  it("detects a doji (tiny body, substantial wicks on both sides)", () => {
    const c = candle(0, 1.1, 1.106, 1.094, 1.101);
    expect(detectCandlestickPattern([c], 0)).toBe("doji");
  });

  it("prefers pin bar over doji when only one side has a long wick", () => {
    const c = candle(0, 1.095, 1.101, 1.05, 1.1);
    expect(detectCandlestickPattern([c], 0)).toBe("pin_bar_bullish");
  });

  it("returns null when no pattern matches", () => {
    const candles = [candle(0, 1.0, 1.003, 0.998, 1.001), candle(1, 1.001, 1.004, 0.999, 1.002)];
    expect(detectCandlestickPattern(candles, 1)).toBeNull();
  });
});
