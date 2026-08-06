import { describe, expect, it } from "vitest";
import { calculateRsi } from "../rsi";
import { candle } from "../../detectors/__tests__/fixtures";

function closesToCandles(closes: number[]) {
  return closes.map((c, i) => candle(i, c, c, c, c));
}

describe("calculateRsi", () => {
  it("approaches 100 on a strictly rising series (no losses)", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const result = calculateRsi(closesToCandles(closes), 14);
    expect(result[14]).toBeCloseTo(100, 5);
    expect(result[19]).toBeCloseTo(100, 5);
  });

  it("approaches 0 on a strictly falling series (no gains)", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
    const result = calculateRsi(closesToCandles(closes), 14);
    expect(result[14]).toBeCloseTo(0, 5);
    expect(result[19]).toBeCloseTo(0, 5);
  });

  it("is NaN before there are enough price changes", () => {
    const closes = Array.from({ length: 10 }, (_, i) => 100 + i);
    const result = calculateRsi(closesToCandles(closes), 14);
    expect(result.every((v) => Number.isNaN(v))).toBe(true);
  });
});
