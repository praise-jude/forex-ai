import { describe, expect, it } from "vitest";
import { findSweepCandidates } from "../signalEngine";
import type { LiquiditySweep, SwingPoint } from "../types";

function sweep(sweepIndex: number, side: "buyside" | "sellside", price = 1.0): LiquiditySweep {
  const swing: SwingPoint = { index: sweepIndex - 1, time: sweepIndex, price, type: side === "buyside" ? "high" : "low" };
  return { sweptSwing: swing, sweepIndex, side };
}

describe("findSweepCandidates", () => {
  it("returns both a bullish and a bearish candidate when both sides swept recently", () => {
    // A sellside sweep implies a bullish reversal candidate; a buyside sweep implies a
    // bearish one -- both can be real at once (e.g. a range's high and low both swept).
    const sweeps = [sweep(10, "sellside"), sweep(12, "buyside")];
    const { bullish, bearish } = findSweepCandidates(sweeps);
    expect(bullish?.side).toBe("sellside");
    expect(bearish?.side).toBe("buyside");
  });

  it("returns only the side that actually has a sweep", () => {
    const { bullish, bearish } = findSweepCandidates([sweep(10, "sellside")]);
    expect(bullish?.side).toBe("sellside");
    expect(bearish).toBeUndefined();
  });

  it("returns undefined for both when there are no sweeps at all", () => {
    expect(findSweepCandidates([])).toEqual({ bullish: undefined, bearish: undefined });
  });

  it("picks the MOST RECENT sweep on each side independently, not just the most recent overall", () => {
    // Two sellside sweeps (indices 5 and 15) and one buyside sweep (index 10) in
    // between -- the bullish candidate must be the later sellside sweep (15), not the
    // earlier one, and the bearish candidate is unaffected by either sellside sweep.
    const sweeps = [sweep(5, "sellside"), sweep(10, "buyside"), sweep(15, "sellside")];
    const { bullish, bearish } = findSweepCandidates(sweeps);
    expect(bullish?.sweepIndex).toBe(15);
    expect(bearish?.sweepIndex).toBe(10);
  });
});
