import { describe, expect, it } from "vitest";
import { detectLiquiditySweeps } from "../liquiditySweeps";
import { candle } from "./fixtures";
import type { SwingPoint } from "../../types";

describe("detectLiquiditySweeps", () => {
  it("detects a buyside sweep: wick above a swing high that closes back below it", () => {
    const candles = [
      candle(0, 1.0, 1.05, 0.98, 1.02),
      candle(1, 1.02, 1.1, 1.0, 1.08), // the swing candle itself
      candle(2, 1.08, 1.09, 1.07, 1.085),
      candle(3, 1.085, 1.13, 1.08, 1.09), // wicks above 1.10, closes back below
    ];
    const swings: SwingPoint[] = [{ index: 1, time: 1, price: 1.1, type: "high" }];

    const sweeps = detectLiquiditySweeps(candles, swings);

    expect(sweeps).toEqual([{ sweptSwing: swings[0], sweepIndex: 3, side: "buyside" }]);
  });

  it("detects a sellside sweep: wick below a swing low that closes back above it", () => {
    const candles = [
      candle(0, 1.1, 1.12, 1.05, 1.08),
      candle(1, 1.08, 1.09, 1.0, 1.02), // the swing candle itself
      candle(2, 1.02, 1.03, 1.01, 1.025),
      candle(3, 1.025, 1.03, 0.97, 1.01), // wicks below 1.00, closes back above
    ];
    const swings: SwingPoint[] = [{ index: 1, time: 1, price: 1.0, type: "low" }];

    const sweeps = detectLiquiditySweeps(candles, swings);

    expect(sweeps).toEqual([{ sweptSwing: swings[0], sweepIndex: 3, side: "sellside" }]);
  });

  it("finds nothing when price never wicks through the swing", () => {
    const candles = [
      candle(0, 1.0, 1.05, 0.98, 1.02),
      candle(1, 1.02, 1.1, 1.0, 1.08),
      candle(2, 1.08, 1.09, 1.07, 1.085),
    ];
    const swings: SwingPoint[] = [{ index: 1, time: 1, price: 1.1, type: "high" }];

    expect(detectLiquiditySweeps(candles, swings)).toEqual([]);
  });
});
