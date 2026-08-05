import { describe, expect, it } from "vitest";
import { detectSwingPoints } from "../swings";
import { detectStructureBreaks } from "../structure";
import { candle } from "./fixtures";

describe("detectStructureBreaks", () => {
  it("flags a BOS_BULLISH when close breaks above the prior swing high", () => {
    const candles = [
      candle(0, 1.0, 1.02, 0.98, 1.01),
      candle(1, 1.01, 1.08, 1.0, 1.05),
      candle(2, 1.05, 1.2, 1.04, 1.1), // swing high @ 1.20
      candle(3, 1.1, 1.15, 1.05, 1.08),
      candle(4, 1.08, 1.12, 1.02, 1.04),
      candle(5, 1.04, 1.1, 1.0, 1.06), // swing low @ 1.00
      candle(6, 1.06, 1.23, 1.05, 1.22), // closes above 1.20 -> BOS_BULLISH
      candle(7, 1.22, 1.24, 1.18, 1.2),
      candle(8, 1.2, 1.23, 1.15, 1.18),
    ];

    const swings = detectSwingPoints(candles, 2);
    const events = detectStructureBreaks(candles, swings);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("BOS_BULLISH");
    expect(events[0].breakIndex).toBe(6);
    expect(events[0].brokenSwing.price).toBe(1.2);
  });

  it("produces no events when price never closes beyond a swing", () => {
    const candles = [
      candle(0, 1.0, 1.02, 0.98, 1.01),
      candle(1, 1.01, 1.08, 1.0, 1.05),
      candle(2, 1.05, 1.2, 1.04, 1.1),
      candle(3, 1.1, 1.15, 1.05, 1.08),
      candle(4, 1.08, 1.12, 1.02, 1.04),
    ];

    const swings = detectSwingPoints(candles, 2);
    expect(detectStructureBreaks(candles, swings)).toEqual([]);
  });
});
