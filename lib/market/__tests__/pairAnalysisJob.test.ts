import { describe, expect, it } from "vitest";
import { ANALYSIS_STAGE_PCT, computeMoneyAtRisk, normalizeDirectionalPercentages, rawDirectionalScore } from "../pairAnalysisJob";
import type { AnalysisStage, SignalEvaluation } from "../types";
import { buildSignal } from "./fixtures";

describe("computeMoneyAtRisk", () => {
  it("computes the same risk-amount math positionSizing.ts uses at execution time", () => {
    expect(computeMoneyAtRisk(1000, 1)).toEqual({ balance: 1000, riskPct: 1, amount: 10 });
  });

  it("handles a fractional risk percentage", () => {
    expect(computeMoneyAtRisk(500, 0.25)).toEqual({ balance: 500, riskPct: 0.25, amount: 1.25 });
  });

  it("is zero when balance is zero, never a fabricated amount", () => {
    expect(computeMoneyAtRisk(0, 1)).toEqual({ balance: 0, riskPct: 1, amount: 0 });
  });
});

describe("rawDirectionalScore", () => {
  it("is 0 for a null evaluation (that side never even ran)", () => {
    expect(rawDirectionalScore(null)).toBe(0);
  });

  it("uses the real signal's confidence when the side qualified outright", () => {
    const evaluation: SignalEvaluation = { status: "signal", signal: buildSignal({ confidence: 91 }) };
    expect(rawDirectionalScore(evaluation)).toBe(91);
  });

  it("surfaces SMC's real near-miss entry score for below_threshold -- never fabricated, the same number the gate itself computed", () => {
    const evaluation: SignalEvaluation = {
      status: "no_trade",
      reason: {
        code: "below_threshold",
        direction: { total: 85, tier: "strong_buy", reasons: [] },
        entry: { total: 67, tier: "watch", reasons: [] },
      },
    };
    expect(rawDirectionalScore(evaluation)).toBe(67);
  });

  it("surfaces the Range Engine's real combined total for range_below_threshold", () => {
    const evaluation: SignalEvaluation = {
      status: "no_trade",
      reason: { code: "range_below_threshold", total: 55, impliedDirection: "long" },
    };
    expect(rawDirectionalScore(evaluation)).toBe(55);
  });

  it("is 0 for a hard-gate reason that never computed a score at all -- fabricating one here would violate the no-fabrication principle", () => {
    const evaluation: SignalEvaluation = { status: "no_trade", reason: { code: "weak_trend_adx", adx: 14.2 } };
    expect(rawDirectionalScore(evaluation)).toBe(0);
  });

  it("is 0 for every other hard-gate reason code too (outside_killzone, no_setup, blackouts, conflicts, etc.)", () => {
    const hardGateReasons: SignalEvaluation[] = [
      { status: "no_trade", reason: { code: "outside_killzone" } },
      { status: "no_trade", reason: { code: "no_setup" } },
      { status: "no_trade", reason: { code: "not_ranging", regime: "strong_uptrend" } },
      { status: "no_trade", reason: { code: "no_range_detected" } },
      { status: "no_trade", reason: { code: "no_boundary_touch" } },
      { status: "no_trade", reason: { code: "signer_b_neutral", impliedDirection: "long" } },
      { status: "no_trade", reason: { code: "m5_not_confirmed", impliedDirection: "short" } },
    ];
    for (const evaluation of hardGateReasons) {
      expect(rawDirectionalScore(evaluation)).toBe(0);
    }
  });
});

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
