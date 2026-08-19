import { describe, expect, it } from "vitest";
import { calibratedMultiplier, computeLotSize, confidenceAdjustedRiskPct } from "../positionSizing";
import { buildSignal, buildSpec } from "./fixtures";
import type { ConfidenceCalibrationBucket } from "../tradeJournal";

const BASE_CONFIG = { confidenceSizingEnabled: true, riskMultiplierBuy: 1.0, riskMultiplierStrongBuy: 1.5 };

describe("computeLotSize", () => {
  it("sizes to risk exactly the requested percentage of equity", () => {
    // 20 pip stop, $10 pip value/lot, 1% of $10,000 = $100 risk -> 0.5 lots.
    const signal = buildSignal({ pair: "EUR/USD", entry: 1.105, stopLoss: 1.103 });
    const result = computeLotSize(signal, 10000, 1, buildSpec());

    expect(result).toEqual({ lots: 0.5 });
  });

  it("rounds down to the broker's volume step rather than up", () => {
    // 20 pip stop, $10 pip value/lot, 1% of $10,100 = $101 risk -> raw lots 0.505,
    // which must round down to 0.50 on a 0.01 step, never up to 0.51.
    const signal = buildSignal({ entry: 1.105, stopLoss: 1.103 });
    const result = computeLotSize(signal, 10100, 1, buildSpec());

    expect(result).toEqual({ lots: 0.5 });
  });

  it("skips rather than rounding up to the minimum when the risk-correct size is too small", () => {
    const signal = buildSignal({ entry: 1.105, stopLoss: 1.103 });
    const result = computeLotSize(signal, 100, 1, buildSpec({ volumeMin: 0.01 }));

    expect(result).toEqual({ skipped: true, reason: expect.stringContaining("below the broker minimum") });
  });

  it("caps at the broker's maximum volume", () => {
    const signal = buildSignal({ entry: 1.105, stopLoss: 1.1045 });
    const result = computeLotSize(signal, 1_000_000, 1, buildSpec({ volumeMax: 100 }));

    expect(result).toEqual({ lots: 100 });
  });

  it("skips when entry and stop loss are equal", () => {
    const signal = buildSignal({ entry: 1.105, stopLoss: 1.105 });
    const result = computeLotSize(signal, 10000, 1, buildSpec());

    expect(result).toEqual({ skipped: true, reason: expect.stringContaining("zero pip distance") });
  });
});

describe("confidenceAdjustedRiskPct", () => {
  it("passes the base risk % through unchanged when disabled", () => {
    expect(confidenceAdjustedRiskPct(1, "strong_buy", { ...BASE_CONFIG, confidenceSizingEnabled: false })).toBe(1);
  });

  it("applies riskMultiplierBuy for a buy-tier signal", () => {
    expect(confidenceAdjustedRiskPct(1, "buy", { ...BASE_CONFIG, riskMultiplierBuy: 1.2 })).toBeCloseTo(1.2);
  });

  it("applies riskMultiplierStrongBuy for a strong_buy-tier signal", () => {
    expect(confidenceAdjustedRiskPct(1, "strong_buy", { ...BASE_CONFIG, riskMultiplierStrongBuy: 1.5 })).toBeCloseTo(1.5);
  });

  it("never amplifies a watch-tier signal even when enabled", () => {
    expect(confidenceAdjustedRiskPct(1, "watch", { ...BASE_CONFIG, riskMultiplierBuy: 2, riskMultiplierStrongBuy: 3 })).toBe(1);
  });

  it("defaults to no scaling (1.0x) when both multipliers are left at their defaults", () => {
    expect(confidenceAdjustedRiskPct(0.25, "buy", BASE_CONFIG)).toBeCloseTo(0.25);
  });

  function buildBucket(overrides: Partial<ConfidenceCalibrationBucket> = {}): ConfidenceCalibrationBucket {
    return { tier: "buy", sampleSize: 30, status: "calibrated", winRate: 60, averageR: 0.4, expectancy: 0.4, ...overrides };
  }

  it("falls back to the manual multiplier when no calibration data is supplied at all (every pre-existing call site)", () => {
    expect(confidenceAdjustedRiskPct(1, "strong_buy", { ...BASE_CONFIG, riskMultiplierStrongBuy: 1.5 })).toBeCloseTo(1.5);
  });

  it("falls back to the manual multiplier when the tier's bucket is still insufficient_data", () => {
    const calibration = [buildBucket({ tier: "buy", status: "insufficient_data", sampleSize: 12, expectancy: null })];
    expect(confidenceAdjustedRiskPct(1, "buy", { ...BASE_CONFIG, riskMultiplierBuy: 1.2 }, calibration)).toBeCloseTo(1.2);
  });

  it("uses the real calibrated multiplier once a tier has enough samples, overriding the manual one", () => {
    // expectancy +0.4R -> calibrated multiplier 1.4x, not the manual 1.2x.
    const calibration = [buildBucket({ tier: "buy", expectancy: 0.4 })];
    expect(confidenceAdjustedRiskPct(1, "buy", { ...BASE_CONFIG, riskMultiplierBuy: 1.2 }, calibration)).toBeCloseTo(1.4);
  });

  it("a tier with real negative expectancy sizes DOWN, even with confidence sizing enabled", () => {
    const calibration = [buildBucket({ tier: "strong_buy", expectancy: -0.3 })];
    expect(confidenceAdjustedRiskPct(1, "strong_buy", BASE_CONFIG, calibration)).toBeCloseTo(0.7);
  });

  it("only affects the tier it has real data for -- the other tier still falls back to its own manual multiplier", () => {
    const calibration = [buildBucket({ tier: "buy", expectancy: 0.4 })];
    expect(confidenceAdjustedRiskPct(1, "strong_buy", { ...BASE_CONFIG, riskMultiplierStrongBuy: 1.5 }, calibration)).toBeCloseTo(1.5);
  });
});

describe("calibratedMultiplier", () => {
  function buildBucket(overrides: Partial<ConfidenceCalibrationBucket> = {}): ConfidenceCalibrationBucket {
    return { tier: "buy", sampleSize: 30, status: "calibrated", winRate: 60, averageR: 0.4, expectancy: 0.4, ...overrides };
  }

  it("is null when there's no bucket at all", () => {
    expect(calibratedMultiplier(undefined)).toBeNull();
  });

  it("is null when the bucket is still insufficient_data", () => {
    expect(calibratedMultiplier(buildBucket({ status: "insufficient_data", expectancy: null }))).toBeNull();
  });

  it("is 1 + expectancy once calibrated", () => {
    expect(calibratedMultiplier(buildBucket({ expectancy: 0.4 }))).toBeCloseTo(1.4);
    expect(calibratedMultiplier(buildBucket({ expectancy: 0 }))).toBeCloseTo(1.0);
    expect(calibratedMultiplier(buildBucket({ expectancy: -0.4 }))).toBeCloseTo(0.6);
  });

  it("clamps to the [0.5, 2.0] safety band even with an extreme real expectancy", () => {
    expect(calibratedMultiplier(buildBucket({ expectancy: 5 }))).toBe(2.0);
    expect(calibratedMultiplier(buildBucket({ expectancy: -5 }))).toBe(0.5);
  });
});
