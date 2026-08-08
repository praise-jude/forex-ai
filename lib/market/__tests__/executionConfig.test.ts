import { afterEach, describe, expect, it } from "vitest";
import { loadExecutionConfig } from "../executionConfig";

const ENV_VARS = [
  "RISK_PER_TRADE_PCT",
  "MAX_CONCURRENT_POSITIONS",
  "MAX_DAILY_LOSS_PCT",
  "MAX_TRADES_PER_DAY",
  "MAX_CONSECUTIVE_LOSSES",
  "COOLDOWN_MINUTES",
  "KILL_SWITCH_FILE",
  "DEMO_RISK_PER_TRADE_PCT",
  "DEMO_MAX_CONCURRENT_POSITIONS",
  "DEMO_MAX_DAILY_LOSS_PCT",
  "DEMO_MAX_TRADES_PER_DAY",
  "DEMO_MAX_CONSECUTIVE_LOSSES",
  "DEMO_COOLDOWN_MINUTES",
  "KILL_SWITCH_FILE_DEMO",
];

describe("loadExecutionConfig", () => {
  afterEach(() => {
    for (const name of ENV_VARS) delete process.env[name];
  });

  it("defaults to the same values for live and demo when nothing is set", () => {
    expect(loadExecutionConfig("live")).toEqual({
      riskPerTradePct: 1,
      maxConcurrentPositions: 3,
      maxDailyLossPct: 5,
      maxTradesPerDay: 5,
      maxConsecutiveLosses: 3,
      cooldownMinutes: 30,
      killSwitchFile: ".trading-paused",
    });
    expect(loadExecutionConfig("demo")).toEqual({
      riskPerTradePct: 1,
      maxConcurrentPositions: 3,
      maxDailyLossPct: 5,
      maxTradesPerDay: 5,
      maxConsecutiveLosses: 3,
      cooldownMinutes: 30,
      killSwitchFile: ".trading-paused-demo",
    });
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
});
