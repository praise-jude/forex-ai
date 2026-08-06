import { describe, expect, it } from "vitest";
import { isAboveAverageVolume } from "../volume";
import type { Candle } from "../../types";

function candleWithVolume(time: number, tickVolume: number): Candle {
  return { time, open: 1, high: 1, low: 1, close: 1, tickVolume };
}

describe("isAboveAverageVolume", () => {
  it("compares the candle at index against the mean of the preceding window", () => {
    const candles: Candle[] = Array.from({ length: 20 }, (_, i) => candleWithVolume(i, 100));
    candles.push(candleWithVolume(20, 150)); // above the 100-average
    candles.push(candleWithVolume(21, 50)); // below the 100-average

    expect(isAboveAverageVolume(candles, 20, 20)).toBe(true);
    expect(isAboveAverageVolume(candles, 21, 20)).toBe(false);
  });

  it("returns false when there isn't enough preceding history", () => {
    const candles: Candle[] = Array.from({ length: 5 }, (_, i) => candleWithVolume(i, 100));
    expect(isAboveAverageVolume(candles, 4, 20)).toBe(false);
  });
});
