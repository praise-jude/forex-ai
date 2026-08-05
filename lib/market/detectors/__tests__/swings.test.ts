import { describe, expect, it } from "vitest";
import { detectSwingPoints } from "../swings";
import { candle } from "./fixtures";

describe("detectSwingPoints", () => {
  it("finds a swing high at a clean local peak", () => {
    const candles = [
      candle(0, 1.0, 1.0, 0.9, 1.0),
      candle(1, 1.05, 1.1, 1.0, 1.05),
      candle(2, 1.1, 1.2, 1.1, 1.15), // peak
      candle(3, 1.1, 1.1, 1.0, 1.05),
      candle(4, 1.0, 1.0, 0.9, 0.95),
    ];

    const swings = detectSwingPoints(candles, 2);

    expect(swings).toEqual([{ index: 2, time: 2, price: 1.2, type: "high" }]);
  });

  it("does not flag a swing in a monotonic run", () => {
    const candles = [
      candle(0, 1.0, 1.0, 0.9, 1.0),
      candle(1, 1.05, 1.1, 1.0, 1.05),
      candle(2, 1.1, 1.2, 1.1, 1.15),
      candle(3, 1.15, 1.3, 1.2, 1.25),
      candle(4, 1.25, 1.4, 1.3, 1.35),
    ];

    expect(detectSwingPoints(candles, 2)).toEqual([]);
  });
});
