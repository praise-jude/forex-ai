import { describe, expect, it } from "vitest";
import { emaTrendDirection } from "../emaTrend";
import { candle } from "../../detectors/__tests__/fixtures";
import type { Candle } from "../../types";

function trendingCandles(count: number, direction: "up" | "down", start = 1): Candle[] {
  const step = direction === "up" ? 0.001 : -0.001;
  const candles: Candle[] = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    price += step;
    candles.push(candle(i, open, Math.max(open, price) + 0.0001, Math.min(open, price) - 0.0001, price));
  }
  return candles;
}

describe("emaTrendDirection", () => {
  it("is neutral with fewer than 50 candles (the EMA50 warmup floor)", () => {
    expect(emaTrendDirection(trendingCandles(30, "up"))).toBe("neutral");
  });

  it("reads bullish when EMA20 is above EMA50 in a sustained uptrend", () => {
    expect(emaTrendDirection(trendingCandles(250, "up"))).toBe("bullish");
  });

  it("reads bearish when EMA20 is below EMA50 in a sustained downtrend", () => {
    expect(emaTrendDirection(trendingCandles(250, "down", 2))).toBe("bearish");
  });
});
