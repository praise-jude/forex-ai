import { describe, expect, it } from "vitest";
import { deEscalationSizeMultiplier } from "../deEscalation";

function base(overrides: Partial<Parameters<typeof deEscalationSizeMultiplier>[0]> = {}) {
  return {
    startOfDayEquity: 10_000,
    currentEquity: 10_000,
    maxDailyLossPct: 2,
    deEscalationFraction: 0.5,
    deEscalationSizeMultiplier: 0.5,
    ...overrides,
  };
}

describe("deEscalationSizeMultiplier", () => {
  it("returns full size when there is no drawdown", () => {
    const result = deEscalationSizeMultiplier(base());
    expect(result).toEqual({ active: false, sizeMultiplier: 1 });
  });

  it("returns full size below the de-escalation threshold", () => {
    // threshold = 2% * 0.5 = 1% => $100 on $10k. $50 drawdown is below it.
    const result = deEscalationSizeMultiplier(base({ currentEquity: 9_950 }));
    expect(result).toEqual({ active: false, sizeMultiplier: 1 });
  });

  it("activates at exactly the threshold", () => {
    const result = deEscalationSizeMultiplier(base({ currentEquity: 9_900 }));
    expect(result.active).toBe(true);
    if (result.active) {
      expect(result.sizeMultiplier).toBe(0.5);
      expect(result.drawdownPct).toBeCloseTo(1, 5);
      expect(result.thresholdPct).toBeCloseTo(1, 5);
    }
  });

  it("activates inside the band, below the hard limit", () => {
    // 1.5% drawdown -- past the 1% threshold, below the 2% hard halt.
    const result = deEscalationSizeMultiplier(base({ currentEquity: 9_850 }));
    expect(result.active).toBe(true);
    if (result.active) expect(result.sizeMultiplier).toBe(0.5);
  });

  it("never activates with a zero/negative start-of-day equity", () => {
    expect(deEscalationSizeMultiplier(base({ startOfDayEquity: 0 }))).toEqual({ active: false, sizeMultiplier: 1 });
  });

  it("ignores a misconfigured fraction outside (0, 1)", () => {
    expect(deEscalationSizeMultiplier(base({ deEscalationFraction: 0 }))).toEqual({ active: false, sizeMultiplier: 1 });
    expect(deEscalationSizeMultiplier(base({ deEscalationFraction: 1.5 }))).toEqual({ active: false, sizeMultiplier: 1 });
  });

  it("clamps a misconfigured multiplier >= 1 to a safe 0.5", () => {
    const result = deEscalationSizeMultiplier(base({ currentEquity: 9_850, deEscalationSizeMultiplier: 1.2 }));
    expect(result.active).toBe(true);
    if (result.active) expect(result.sizeMultiplier).toBe(0.5);
  });

  it("never returns a multiplier above 1", () => {
    const result = deEscalationSizeMultiplier(base({ currentEquity: 9_000, deEscalationSizeMultiplier: 0.7 }));
    expect(result.active).toBe(true);
    if (result.active) expect(result.sizeMultiplier).toBeLessThanOrEqual(1);
  });
});
