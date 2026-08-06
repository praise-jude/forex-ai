import { describe, expect, it } from "vitest";
import { calculateAtr } from "../atr";
import { candle } from "../../detectors/__tests__/fixtures";

describe("calculateAtr", () => {
  it("converges to the constant true range on identically-shaped candles", () => {
    // high-low=2, |high-prevClose|=1, |low-prevClose|=1 -> true range is always 2
    const candles = Array.from({ length: 20 }, (_, i) => candle(i, 100, 101, 99, 100));
    const result = calculateAtr(candles, 5);

    expect(result.slice(0, 5).every((v) => Number.isNaN(v))).toBe(true);
    for (let i = 5; i < result.length; i++) expect(result[i]).toBeCloseTo(2, 10);
  });

  it("is NaN before there are enough candles", () => {
    const candles = Array.from({ length: 5 }, (_, i) => candle(i, 100, 101, 99, 100));
    expect(calculateAtr(candles, 14).every((v) => Number.isNaN(v))).toBe(true);
  });
});
