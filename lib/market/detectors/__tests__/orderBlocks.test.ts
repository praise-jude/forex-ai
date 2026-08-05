import { describe, expect, it } from "vitest";
import { detectOrderBlocks } from "../orderBlocks";
import { candle } from "./fixtures";
import type { StructureEvent } from "../../types";

describe("detectOrderBlocks", () => {
  it("finds the last bearish candle before a bullish break and flags it mitigated on return", () => {
    const candles = [
      candle(0, 1.0, 1.02, 0.99, 1.01), // bullish
      candle(1, 1.01, 1.015, 0.985, 0.99), // bearish -> expected order block
      candle(2, 0.99, 1.16, 0.98, 1.15), // impulsive breakout candle
      candle(3, 1.15, 1.17, 1.14, 1.16),
      candle(4, 1.16, 1.16, 0.995, 1.0), // dips back into the OB range -> mitigated
    ];
    const structureEvents: StructureEvent[] = [
      {
        type: "BOS_BULLISH",
        brokenSwing: { index: 0, time: 0, price: 1.0, type: "high" },
        breakIndex: 2,
        time: 2,
      },
    ];

    const blocks = detectOrderBlocks(candles, structureEvents);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ direction: "bullish", index: 1, top: 1.01, bottom: 0.99, mitigated: true });
  });

  it("returns nothing when the break happens on the first candle", () => {
    const candles = [candle(0, 1.0, 1.1, 0.99, 1.08)];
    const structureEvents: StructureEvent[] = [
      {
        type: "BOS_BULLISH",
        brokenSwing: { index: -1, time: 0, price: 1.0, type: "high" },
        breakIndex: 0,
        time: 0,
      },
    ];

    expect(detectOrderBlocks(candles, structureEvents)).toEqual([]);
  });
});
