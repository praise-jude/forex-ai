import { describe, expect, it } from "vitest";
import { ANALYSIS_STAGE_PCT, normalizeDirectionalPercentages } from "../pairAnalysisJob";
import type { AnalysisStage } from "../types";

describe("normalizeDirectionalPercentages", () => {
  it("always sums to exactly 100", () => {
    const cases: [number, number][] = [
      [0, 0],
      [82, 0],
      [0, 61],
      [50, 50],
      [90, 90], // the rare "both sides independently qualify strongly" conflict case
      [12.5, 33.3],
    ];
    for (const [buy, sell] of cases) {
      const { buyPct, sellPct, noTradePct } = normalizeDirectionalPercentages(buy, sell);
      expect(buyPct + sellPct + noTradePct).toBeCloseTo(100, 6);
    }
  });

  it("is 100% no-trade when neither side scored anything", () => {
    expect(normalizeDirectionalPercentages(0, 0)).toEqual({ buyPct: 0, sellPct: 0, noTradePct: 100 });
  });

  it("matches the raw score when only one side qualified and it's under 100", () => {
    const { buyPct, sellPct, noTradePct } = normalizeDirectionalPercentages(82, 0);
    expect(buyPct).toBeCloseTo(82, 6);
    expect(sellPct).toBe(0);
    expect(noTradePct).toBeCloseTo(18, 6);
  });

  it("proportionally rescales, preserving relative weight, when both sides combined exceed 100", () => {
    // 90 + 90 = 180 raw, no room left for a no-trade share -- rescaled down to 50/50/0,
    // not silently capped or negative.
    const { buyPct, sellPct, noTradePct } = normalizeDirectionalPercentages(90, 90);
    expect(buyPct).toBeCloseTo(50, 6);
    expect(sellPct).toBeCloseTo(50, 6);
    expect(noTradePct).toBe(0);
  });
});

describe("ANALYSIS_STAGE_PCT", () => {
  const order: AnalysisStage[] = [
    "market_data",
    "structure",
    "smc_engine",
    "range_engine",
    "multi_timeframe",
    "consensus",
    "risk_validation",
    "final",
  ];

  it("is strictly increasing in the real pipeline order, ending at 100", () => {
    let previous = 0;
    for (const stage of order) {
      expect(ANALYSIS_STAGE_PCT[stage]).toBeGreaterThan(previous);
      previous = ANALYSIS_STAGE_PCT[stage];
    }
    expect(previous).toBe(100);
  });
});
