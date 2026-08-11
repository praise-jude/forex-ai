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
  it("is neutral with fewer than 200 candles (pure extraction of the prior private behavior)", () => {
    expect(emaTrendDirection(trendingCandles(50, "up"))).toBe("neutral");
  });

  it("reads bullish when EMA50 is above EMA200 in a sustained uptrend", () => {
    expect(emaTrendDirection(trendingCandles(250, "up"))).toBe("bullish");
  });

  it("reads bearish when EMA50 is below EMA200 in a sustained downtrend", () => {
    expect(emaTrendDirection(trendingCandles(250, "down", 2))).toBe("bearish");
  });
});
