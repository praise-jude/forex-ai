import { describe, expect, it } from "vitest";
import { detectFairValueGaps } from "../fairValueGaps";
import { candle } from "./fixtures";

describe("detectFairValueGaps", () => {
  it("detects a bullish gap and marks it filled once price returns through it", () => {
    const candles = [
      candle(0, 1.0, 1.05, 0.98, 1.02),
      candle(1, 1.02, 1.09, 1.01, 1.08),
      candle(2, 1.08, 1.15, 1.1, 1.12), // gap: candle0.high(1.05) < candle2.low(1.10)
      candle(3, 1.12, 1.14, 1.09, 1.13),
      candle(4, 1.13, 1.14, 1.0, 1.02), // low dips back through the gap bottom -> filled
    ];

    const gaps = detectFairValueGaps(candles);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ direction: "bullish", startIndex: 0, top: 1.1, bottom: 1.05, filled: true });
  });

  it("finds no gaps when consecutive candles overlap", () => {
    const candles = [
      candle(0, 1.0, 1.05, 0.98, 1.02),
      candle(1, 1.01, 1.04, 0.99, 1.02),
      candle(2, 1.0, 1.05, 0.98, 1.02),
    ];

    expect(detectFairValueGaps(candles)).toEqual([]);
  });
});
