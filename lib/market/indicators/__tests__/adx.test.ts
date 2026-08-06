import { describe, expect, it } from "vitest";
import { calculateAdx } from "../adx";
import { candle } from "../../detectors/__tests__/fixtures";
import type { Candle } from "../../types";

function buildTrend(length: number, step = 1, startPrice = 100): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < length; i++) {
    candles.push(candle(i, price - step, price + 1, price - 1, price));
    price += step;
  }
  return candles;
}

function buildChoppy(length: number, amplitude = 2, base = 100): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < length; i++) {
    const price = base + (i % 2 === 0 ? amplitude : -amplitude);
    candles.push(candle(i, base, price + 1, price - 1, price));
  }
  return candles;
}

describe("calculateAdx", () => {
  it("is much higher on a steady one-directional trend than on a choppy, directionless series", () => {
    const trending = calculateAdx(buildTrend(60), 14);
    const choppy = calculateAdx(buildChoppy(60), 14);

    const trendingLast = trending[trending.length - 1];
    const choppyLast = choppy[choppy.length - 1];

    expect(trendingLast).toBeGreaterThan(90); // a pure one-directional move is close to the ADX ceiling
    expect(choppyLast).toBeLessThan(20);
    expect(trendingLast).toBeGreaterThan(choppyLast);
  });

  it("is NaN before there are enough candles (needs 2*period)", () => {
    const period = 14;
    const short = buildTrend(period * 2 - 1);
    expect(calculateAdx(short, period).every((v) => Number.isNaN(v))).toBe(true);

    const justEnough = buildTrend(period * 2);
    expect(Number.isNaN(calculateAdx(justEnough, period)[period * 2 - 1])).toBe(false);
  });
});
