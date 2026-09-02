import { afterEach, describe, expect, it } from "vitest";
import {
  checkExecutionPolicy,
  getExecutionPolicy,
  resetExecutionPolicyForTests,
  setExecutionPolicy,
  type ExecutionPolicyState,
} from "../executionPolicy";
import { buildSignal } from "./fixtures";
import type { ConfidenceCalibrationBucket } from "../tradeJournal";

function policy(overrides: Partial<ExecutionPolicyState> = {}): ExecutionPolicyState {
  return { minTier: "buy", minRiskReward: 0, calibratedGateEnabled: false, ...overrides };
}

function bucket(overrides: Partial<ConfidenceCalibrationBucket> = {}): ConfidenceCalibrationBucket {
  return { tier: "buy", sampleSize: 30, status: "calibrated", winRate: 0.5, averageR: 0, expectancy: 0, ...overrides };
}

describe("executionPolicy", () => {
  afterEach(() => {
    resetExecutionPolicyForTests();
  });

  it("defaults to today's exact existing behavior: minTier buy, minRiskReward 0, calibrated gate off", () => {
    expect(getExecutionPolicy()).toEqual({ minTier: "buy", minRiskReward: 0, calibratedGateEnabled: false });
  });

  it("setExecutionPolicy updates minTier, minRiskReward, and calibratedGateEnabled independently", () => {
    setExecutionPolicy({ minTier: "strong_buy" });
    expect(getExecutionPolicy()).toEqual(policy({ minTier: "strong_buy" }));

    setExecutionPolicy({ minRiskReward: 2.5 });
    expect(getExecutionPolicy()).toEqual(policy({ minTier: "strong_buy", minRiskReward: 2.5 }));

    setExecutionPolicy({ calibratedGateEnabled: true });
    expect(getExecutionPolicy()).toEqual(policy({ minTier: "strong_buy", minRiskReward: 2.5, calibratedGateEnabled: true }));
  });

  it("ignores a negative or non-finite minRiskReward", () => {
    setExecutionPolicy({ minRiskReward: -1 });
    expect(getExecutionPolicy().minRiskReward).toBe(0);
    setExecutionPolicy({ minRiskReward: Number.NaN });
    expect(getExecutionPolicy().minRiskReward).toBe(0);
  });

  it("resetExecutionPolicyForTests returns to the boot default", () => {
    setExecutionPolicy({ minTier: "strong_buy", minRiskReward: 5, calibratedGateEnabled: true });
    resetExecutionPolicyForTests();
    expect(getExecutionPolicy()).toEqual(policy());
  });

  describe("checkExecutionPolicy", () => {
    it("allows a buy-tier signal when the policy requires only buy", () => {
      const signal = buildSignal({ tier: "buy", riskReward: 2 });
      expect(checkExecutionPolicy(signal, policy())).toEqual({ allowed: true });
    });

    it("blocks a buy-tier signal when the policy requires strong_buy", () => {
      const signal = buildSignal({ tier: "buy", riskReward: 2 });
      const result = checkExecutionPolicy(signal, policy({ minTier: "strong_buy" }));
      expect(result).toEqual({
        allowed: false,
        code: "below_min_tier",
        reason: expect.stringContaining("below the configured minimum"),
      });
    });

    it("allows a strong_buy-tier signal when the policy requires strong_buy", () => {
      const signal = buildSignal({ tier: "strong_buy", riskReward: 2 });
      expect(checkExecutionPolicy(signal, policy({ minTier: "strong_buy" }))).toEqual({ allowed: true });
    });

    it("blocks a signal whose risk/reward is below the configured minimum", () => {
      const signal = buildSignal({ tier: "buy", riskReward: 1.2 });
      const result = checkExecutionPolicy(signal, policy({ minRiskReward: 2 }));
      expect(result).toEqual({
        allowed: false,
        code: "below_min_rr",
        reason: expect.stringContaining("below the configured minimum"),
      });
    });

    it("allows a signal whose risk/reward exactly equals the configured minimum", () => {
      const signal = buildSignal({ tier: "buy", riskReward: 2 });
      expect(checkExecutionPolicy(signal, policy({ minRiskReward: 2 }))).toEqual({ allowed: true });
    });

    it("always allows a tradingview-sourced signal, regardless of policy", () => {
      const signal = buildSignal({ source: "tradingview", tier: "buy", riskReward: 0.1 });
      expect(checkExecutionPolicy(signal, policy({ minTier: "strong_buy", minRiskReward: 10 }))).toEqual({ allowed: true });
    });

    it("always allows a manual (hand-entered) signal, regardless of policy", () => {
      const signal = buildSignal({ source: "manual", tier: "buy", riskReward: 0.1 });
      expect(checkExecutionPolicy(signal, policy({ minTier: "strong_buy", minRiskReward: 10 }))).toEqual({ allowed: true });
    });

    describe("calibrated expectancy gate", () => {
      it("is a no-op when calibratedGateEnabled is off, even with proven-negative calibration data", () => {
        const signal = buildSignal({ tier: "buy", riskReward: 2 });
        const calibration = [bucket({ tier: "buy", expectancy: -0.5 })];
        expect(checkExecutionPolicy(signal, policy({ calibratedGateEnabled: false }), calibration)).toEqual({ allowed: true });
      });

      it("blocks when enabled and the matching tier's real expectancy is negative", () => {
        const signal = buildSignal({ tier: "buy", riskReward: 2 });
        const calibration = [bucket({ tier: "buy", sampleSize: 42, expectancy: -0.35 })];
        const result = checkExecutionPolicy(signal, policy({ calibratedGateEnabled: true }), calibration);
        expect(result).toEqual({
          allowed: false,
          code: "below_calibrated_expectancy",
          reason: expect.stringContaining("negative expectancy"),
        });
      });

      it("allows when enabled but the matching tier's real expectancy is positive", () => {
        const signal = buildSignal({ tier: "buy", riskReward: 2 });
        const calibration = [bucket({ tier: "buy", expectancy: 0.4 })];
        expect(checkExecutionPolicy(signal, policy({ calibratedGateEnabled: true }), calibration)).toEqual({ allowed: true });
      });

      it("never blocks on a tier that hasn't cleared its own real sample-size bar yet", () => {
        const signal = buildSignal({ tier: "buy", riskReward: 2 });
        const calibration = [bucket({ tier: "buy", status: "insufficient_data", winRate: null, averageR: null, expectancy: null })];
        expect(checkExecutionPolicy(signal, policy({ calibratedGateEnabled: true }), calibration)).toEqual({ allowed: true });
      });

      it("never blocks when no calibration data was supplied at all", () => {
        const signal = buildSignal({ tier: "buy", riskReward: 2 });
        expect(checkExecutionPolicy(signal, policy({ calibratedGateEnabled: true }), undefined)).toEqual({ allowed: true });
      });

      it("only consults the SIGNAL's own tier bucket, not an unrelated tier's negative expectancy", () => {
        const signal = buildSignal({ tier: "buy", riskReward: 2 });
        const calibration = [bucket({ tier: "strong_buy", expectancy: -0.9 })];
        expect(checkExecutionPolicy(signal, policy({ calibratedGateEnabled: true }), calibration)).toEqual({ allowed: true });
      });

      it("still allows a tradingview-sourced signal even with a proven-negative calibrated tier", () => {
        const signal = buildSignal({ source: "tradingview", tier: "buy", riskReward: 2 });
        const calibration = [bucket({ tier: "buy", expectancy: -0.5 })];
        expect(checkExecutionPolicy(signal, policy({ calibratedGateEnabled: true }), calibration)).toEqual({ allowed: true });
      });
    });
  });
});
