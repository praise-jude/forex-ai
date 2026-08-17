import { afterEach, describe, expect, it } from "vitest";
import { loadExecutionConfig } from "../executionConfig";

const ENV_VARS = [
  "RISK_PER_TRADE_PCT",
  "MAX_CONCURRENT_POSITIONS",
  "MAX_CORRELATED_POSITIONS",
  "MAX_DAILY_LOSS_PCT",
  "MAX_TRADES_PER_DAY",
  "MAX_CONSECUTIVE_LOSSES",
  "COOLDOWN_MINUTES",
  "MAX_SPREAD_FRACTION_OF_STOP",
  "BREAK_EVEN_TRIGGER_R",
  "TRAILING_ARM_TRIGGER_R",
  "TRAILING_DISTANCE_FRACTION_OF_STOP",
  "POSITION_MANAGEMENT_ENABLED",
  "PARTIAL_CLOSE_ENABLED",
  "PARTIAL_CLOSE_FRACTION",
  "M5_CONFIRMATION_ENABLED",
  "CONFIDENCE_SIZING_ENABLED",
  "RISK_MULTIPLIER_BUY",
  "RISK_MULTIPLIER_STRONG_BUY",
  "KILL_SWITCH_FILE",
  "DEMO_RISK_PER_TRADE_PCT",
  "DEMO_MAX_CONCURRENT_POSITIONS",
  "DEMO_MAX_CORRELATED_POSITIONS",
  "DEMO_MAX_DAILY_LOSS_PCT",
  "DEMO_MAX_TRADES_PER_DAY",
  "DEMO_MAX_CONSECUTIVE_LOSSES",
  "DEMO_COOLDOWN_MINUTES",
  "DEMO_MAX_SPREAD_FRACTION_OF_STOP",
  "DEMO_BREAK_EVEN_TRIGGER_R",
  "DEMO_TRAILING_ARM_TRIGGER_R",
  "DEMO_TRAILING_DISTANCE_FRACTION_OF_STOP",
  "DEMO_POSITION_MANAGEMENT_ENABLED",
  "DEMO_PARTIAL_CLOSE_ENABLED",
  "DEMO_PARTIAL_CLOSE_FRACTION",
  "DEMO_M5_CONFIRMATION_ENABLED",
  "DEMO_CONFIDENCE_SIZING_ENABLED",
  "DEMO_RISK_MULTIPLIER_BUY",
  "DEMO_RISK_MULTIPLIER_STRONG_BUY",
  "KILL_SWITCH_FILE_DEMO",
];

describe("loadExecutionConfig", () => {
  afterEach(() => {
    for (const name of ENV_VARS) delete process.env[name];
  });

  it("defaults to the same values for live and demo when nothing is set", () => {
    expect(loadExecutionConfig("live")).toEqual({
      riskPerTradePct: 0.25,
      maxConcurrentPositions: 3,
      maxCorrelatedPositions: 1,
      maxDailyLossPct: 1,
      maxTradesPerDay: 5,
      maxConsecutiveLosses: 3,
      cooldownMinutes: 30,
      maxSpreadFractionOfStop: 0.15,
      breakEvenTriggerR: 1.0,
      trailingArmTriggerR: 1.5,
      trailingDistanceFractionOfStop: 1.0,
      positionManagementEnabled: true,
      partialCloseEnabled: false,
      partialCloseFraction: 0.5,
      m5ConfirmationEnabled: true,
      confidenceSizingEnabled: false,
      riskMultiplierBuy: 1.0,
      riskMultiplierStrongBuy: 1.5,
      rangeEngineEnabled: false,
      killSwitchFile: ".trading-paused",
    });
    expect(loadExecutionConfig("demo")).toEqual({
      riskPerTradePct: 0.25,
      maxConcurrentPositions: 3,
      maxCorrelatedPositions: 1,
      maxDailyLossPct: 1,
      maxTradesPerDay: 5,
      maxConsecutiveLosses: 3,
      cooldownMinutes: 30,
      maxSpreadFractionOfStop: 0.15,
      breakEvenTriggerR: 1.0,
      trailingArmTriggerR: 1.5,
      trailingDistanceFractionOfStop: 1.0,
      positionManagementEnabled: true,
      partialCloseEnabled: false,
      partialCloseFraction: 0.5,
      m5ConfirmationEnabled: true,
      confidenceSizingEnabled: false,
      riskMultiplierBuy: 1.0,
      riskMultiplierStrongBuy: 1.5,
      rangeEngineEnabled: false,
      killSwitchFile: ".trading-paused-demo",
    });
  });

  it("reads the spread tolerance independently per account too", () => {
    process.env.MAX_SPREAD_FRACTION_OF_STOP = "0.3";
    expect(loadExecutionConfig("live").maxSpreadFractionOfStop).toBe(0.3);
    expect(loadExecutionConfig("demo").maxSpreadFractionOfStop).toBe(0.15); // falls back to the shared default
  });

  it("reads the position-management thresholds independently per account too", () => {
    process.env.BREAK_EVEN_TRIGGER_R = "0.5";
    process.env.DEMO_TRAILING_ARM_TRIGGER_R = "2.5";
    expect(loadExecutionConfig("live").breakEvenTriggerR).toBe(0.5);
    expect(loadExecutionConfig("demo").breakEvenTriggerR).toBe(1.0); // falls back to the shared default
    expect(loadExecutionConfig("live").trailingArmTriggerR).toBe(1.5); // falls back to the shared default
    expect(loadExecutionConfig("demo").trailingArmTriggerR).toBe(2.5);
  });

  it("treats POSITION_MANAGEMENT_ENABLED=false (and other falsy strings) as disabled, anything else as enabled", () => {
    process.env.POSITION_MANAGEMENT_ENABLED = "false";
    expect(loadExecutionConfig("live").positionManagementEnabled).toBe(false);
    process.env.POSITION_MANAGEMENT_ENABLED = "0";
    expect(loadExecutionConfig("live").positionManagementEnabled).toBe(false);
    process.env.POSITION_MANAGEMENT_ENABLED = "true";
    expect(loadExecutionConfig("live").positionManagementEnabled).toBe(true);
    expect(loadExecutionConfig("demo").positionManagementEnabled).toBe(true); // unset -- falls back to the default
  });

  it("reads DEMO_-prefixed vars independently of the live ones", () => {
    process.env.RISK_PER_TRADE_PCT = "2";
    process.env.DEMO_RISK_PER_TRADE_PCT = "10";

    expect(loadExecutionConfig("live").riskPerTradePct).toBe(2);
    expect(loadExecutionConfig("demo").riskPerTradePct).toBe(10);
  });

  it("falls back to the shared default, not live's configured value, when a DEMO_ var is unset", () => {
    process.env.MAX_CONCURRENT_POSITIONS = "10"; // live tuned way up
    expect(loadExecutionConfig("demo").maxConcurrentPositions).toBe(3); // demo still gets the plain default
  });

  it("reads the cooldown settings independently per account too", () => {
    process.env.MAX_CONSECUTIVE_LOSSES = "5";
    process.env.DEMO_COOLDOWN_MINUTES = "10";

    expect(loadExecutionConfig("live").maxConsecutiveLosses).toBe(5);
    expect(loadExecutionConfig("demo").maxConsecutiveLosses).toBe(3); // falls back to the shared default
    expect(loadExecutionConfig("live").cooldownMinutes).toBe(30);
    expect(loadExecutionConfig("demo").cooldownMinutes).toBe(10);
  });

  it("respects a custom KILL_SWITCH_FILE_DEMO path", () => {
    process.env.KILL_SWITCH_FILE_DEMO = ".custom-demo-pause";
    expect(loadExecutionConfig("demo").killSwitchFile).toBe(".custom-demo-pause");
  });

  it("reads the confidence-sizing settings independently per account too", () => {
    process.env.CONFIDENCE_SIZING_ENABLED = "true";
    process.env.RISK_MULTIPLIER_BUY = "1.2";
    process.env.DEMO_RISK_MULTIPLIER_STRONG_BUY = "2";

    expect(loadExecutionConfig("live").confidenceSizingEnabled).toBe(true);
    expect(loadExecutionConfig("demo").confidenceSizingEnabled).toBe(false); // falls back to the shared default
    expect(loadExecutionConfig("live").riskMultiplierBuy).toBe(1.2);
    expect(loadExecutionConfig("demo").riskMultiplierBuy).toBe(1.0); // falls back to the shared default
    expect(loadExecutionConfig("live").riskMultiplierStrongBuy).toBe(1.5); // falls back to the shared default
    expect(loadExecutionConfig("demo").riskMultiplierStrongBuy).toBe(2);
  });

  it("falls back to 1.0 (no scaling) for a non-positive or non-numeric multiplier, never the operator's stray value", () => {
    process.env.RISK_MULTIPLIER_BUY = "0";
    expect(loadExecutionConfig("live").riskMultiplierBuy).toBe(1.0);
    process.env.RISK_MULTIPLIER_BUY = "-2";
    expect(loadExecutionConfig("live").riskMultiplierBuy).toBe(1.0);
    process.env.RISK_MULTIPLIER_STRONG_BUY = "not-a-number";
    expect(loadExecutionConfig("live").riskMultiplierStrongBuy).toBe(1.0);
  });
});
