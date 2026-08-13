import { afterEach, describe, expect, it } from "vitest";
import {
  checkExecutionPolicy,
  getExecutionPolicy,
  resetExecutionPolicyForTests,
  setExecutionPolicy,
} from "../executionPolicy";
import { buildSignal } from "./fixtures";

describe("executionPolicy", () => {
  afterEach(() => {
    resetExecutionPolicyForTests();
  });

  it("defaults to today's exact existing behavior: minTier buy, minRiskReward 0", () => {
    expect(getExecutionPolicy()).toEqual({ minTier: "buy", minRiskReward: 0 });
  });

  it("setExecutionPolicy updates minTier and minRiskReward independently", () => {
    setExecutionPolicy({ minTier: "strong_buy" });
    expect(getExecutionPolicy()).toEqual({ minTier: "strong_buy", minRiskReward: 0 });

    setExecutionPolicy({ minRiskReward: 2.5 });
    expect(getExecutionPolicy()).toEqual({ minTier: "strong_buy", minRiskReward: 2.5 });
  });

  it("ignores a negative or non-finite minRiskReward", () => {
    setExecutionPolicy({ minRiskReward: -1 });
    expect(getExecutionPolicy().minRiskReward).toBe(0);
    setExecutionPolicy({ minRiskReward: Number.NaN });
    expect(getExecutionPolicy().minRiskReward).toBe(0);
  });

  it("resetExecutionPolicyForTests returns to the boot default", () => {
    setExecutionPolicy({ minTier: "strong_buy", minRiskReward: 5 });
    resetExecutionPolicyForTests();
    expect(getExecutionPolicy()).toEqual({ minTier: "buy", minRiskReward: 0 });
  });

  describe("checkExecutionPolicy", () => {
    it("allows a buy-tier signal when the policy requires only buy", () => {
      const signal = buildSignal({ tier: "buy", riskReward: 2 });
      expect(checkExecutionPolicy(signal, { minTier: "buy", minRiskReward: 0 })).toEqual({ allowed: true });
    });

    it("blocks a buy-tier signal when the policy requires strong_buy", () => {
      const signal = buildSignal({ tier: "buy", riskReward: 2 });
      const result = checkExecutionPolicy(signal, { minTier: "strong_buy", minRiskReward: 0 });
      expect(result).toEqual({
        allowed: false,
        code: "below_min_tier",
        reason: expect.stringContaining("below the configured minimum"),
      });
    });

    it("allows a strong_buy-tier signal when the policy requires strong_buy", () => {
      const signal = buildSignal({ tier: "strong_buy", riskReward: 2 });
      expect(checkExecutionPolicy(signal, { minTier: "strong_buy", minRiskReward: 0 })).toEqual({ allowed: true });
    });

    it("blocks a signal whose risk/reward is below the configured minimum", () => {
      const signal = buildSignal({ tier: "buy", riskReward: 1.2 });
      const result = checkExecutionPolicy(signal, { minTier: "buy", minRiskReward: 2 });
      expect(result).toEqual({
        allowed: false,
        code: "below_min_rr",
        reason: expect.stringContaining("below the configured minimum"),
      });
    });

    it("allows a signal whose risk/reward exactly equals the configured minimum", () => {
      const signal = buildSignal({ tier: "buy", riskReward: 2 });
      expect(checkExecutionPolicy(signal, { minTier: "buy", minRiskReward: 2 })).toEqual({ allowed: true });
    });

    it("always allows a tradingview-sourced signal, regardless of policy", () => {
      const signal = buildSignal({ source: "tradingview", tier: "buy", riskReward: 0.1 });
      expect(checkExecutionPolicy(signal, { minTier: "strong_buy", minRiskReward: 10 })).toEqual({ allowed: true });
    });
  });
});
