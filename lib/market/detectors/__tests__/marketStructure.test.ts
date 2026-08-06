import { describe, expect, it } from "vitest";
import { marketStructureTrend } from "../marketStructure";
import type { SwingPoint } from "../../types";

function swing(index: number, price: number, type: "high" | "low"): SwingPoint {
  return { index, time: index, price, type };
}

describe("marketStructureTrend", () => {
  it("is bullish on higher-high + higher-low", () => {
    const swings = [swing(0, 1.0, "high"), swing(1, 0.98, "low"), swing(2, 1.05, "high"), swing(3, 1.0, "low")];
    expect(marketStructureTrend(swings)).toBe("bullish");
  });

  it("is bearish on lower-high + lower-low", () => {
    const swings = [swing(0, 1.05, "high"), swing(1, 1.0, "low"), swing(2, 1.0, "high"), swing(3, 0.98, "low")];
    expect(marketStructureTrend(swings)).toBe("bearish");
  });

  it("is neutral when highs and lows disagree", () => {
    const swings = [swing(0, 1.0, "high"), swing(1, 0.98, "low"), swing(2, 1.05, "high"), swing(3, 0.95, "low")];
    expect(marketStructureTrend(swings)).toBe("neutral");
  });

  it("is neutral with fewer than two swing highs or lows", () => {
    expect(marketStructureTrend([swing(0, 1.0, "high"), swing(1, 0.98, "low")])).toBe("neutral");
  });
});
