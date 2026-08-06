import { describe, expect, it } from "vitest";
import { isEmaStackAligned } from "../emaStack";
import { candle } from "../../detectors/__tests__/fixtures";
import type { Candle } from "../../types";

function buildTrend(length: number, step: number, startPrice = 100): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < length; i++) {
    candles.push(candle(i, price, price + 0.1, price - 0.1, price));
    price += step;
  }
  return candles;
}

describe("isEmaStackAligned", () => {
  it("is true for long on a sustained uptrend, false for short on the same data", () => {
    const uptrend = buildTrend(250, 0.1);
    expect(isEmaStackAligned(uptrend, "long")).toBe(true);
    expect(isEmaStackAligned(uptrend, "short")).toBe(false);
  });

  it("is true for short on a sustained downtrend, false for long on the same data", () => {
    const downtrend = buildTrend(250, -0.1, 150);
    expect(isEmaStackAligned(downtrend, "short")).toBe(true);
    expect(isEmaStackAligned(downtrend, "long")).toBe(false);
  });

  it("is false when there isn't enough warm-up history for EMA200", () => {
    const short = buildTrend(50, 0.1);
    expect(isEmaStackAligned(short, "long")).toBe(false);
  });
});
