import { afterEach, describe, expect, it } from "vitest";
import { checkRiskLimits, isEnvKillSwitchActive, isKillSwitchActive, type RiskCheckInput } from "../riskManager";

function buildInput(overrides: Partial<RiskCheckInput> = {}): RiskCheckInput {
  return {
    killSwitchActive: false,
    haltedForToday: false,
    openPositionCount: 0,
    maxConcurrentPositions: 3,
    tradesOpenedToday: 0,
    maxTradesPerDay: 5,
    startOfDayEquity: 10000,
    currentEquity: 10000,
    maxDailyLossPct: 5,
    ...overrides,
  };
}

describe("checkRiskLimits", () => {
  it("allows execution when nothing is tripped", () => {
    expect(checkRiskLimits(buildInput())).toEqual({ allowed: true });
  });

  it("blocks on the kill switch, even if other limits are also over", () => {
    const result = checkRiskLimits(buildInput({ killSwitchActive: true, openPositionCount: 99 }));
    expect(result).toEqual({ allowed: false, code: "kill_switch", reason: "kill switch is active" });
  });

  it("blocks when already halted for today", () => {
    const result = checkRiskLimits(buildInput({ haltedForToday: true }));
    expect(result).toEqual({
      allowed: false,
      code: "halted",
      reason: "trading halted for today (daily loss limit already tripped)",
    });
  });

  it("blocks at the max concurrent positions limit", () => {
    const result = checkRiskLimits(buildInput({ openPositionCount: 3, maxConcurrentPositions: 3 }));
    expect(result.allowed).toBe(false);
    expect((result as { code: string }).code).toBe("max_positions");
  });

  it("blocks at the max trades per day limit", () => {
    const result = checkRiskLimits(buildInput({ tradesOpenedToday: 5, maxTradesPerDay: 5 }));
    expect(result.allowed).toBe(false);
    expect((result as { code: string }).code).toBe("max_trades");
  });

  it("blocks once the daily loss threshold is reached", () => {
    const result = checkRiskLimits(buildInput({ startOfDayEquity: 10000, currentEquity: 9500, maxDailyLossPct: 5 }));
    expect(result.allowed).toBe(false);
    expect((result as { code: string }).code).toBe("daily_loss");
  });

  it("allows when the drawdown is under the daily loss threshold", () => {
    const result = checkRiskLimits(buildInput({ startOfDayEquity: 10000, currentEquity: 9600, maxDailyLossPct: 5 }));
    expect(result).toEqual({ allowed: true });
  });
});

describe("isKillSwitchActive", () => {
  const NONEXISTENT_FILE = "___does-not-exist___.tmp";

  afterEach(() => {
    delete process.env.TRADING_KILL_SWITCH;
  });

  it("is false when neither the file nor the env var is set", () => {
    expect(isKillSwitchActive(NONEXISTENT_FILE)).toBe(false);
  });

  it("is true when TRADING_KILL_SWITCH is set to a truthy value, even without the file", () => {
    process.env.TRADING_KILL_SWITCH = "1";
    expect(isKillSwitchActive(NONEXISTENT_FILE)).toBe(true);
  });

  it("treats \"0\" and \"false\" as not set", () => {
    process.env.TRADING_KILL_SWITCH = "0";
    expect(isKillSwitchActive(NONEXISTENT_FILE)).toBe(false);
    process.env.TRADING_KILL_SWITCH = "false";
    expect(isKillSwitchActive(NONEXISTENT_FILE)).toBe(false);
  });
});

describe("isEnvKillSwitchActive", () => {
  afterEach(() => {
    delete process.env.TRADING_KILL_SWITCH;
  });

  it("is false when unset, true when set truthy -- independent of any file", () => {
    expect(isEnvKillSwitchActive()).toBe(false);
    process.env.TRADING_KILL_SWITCH = "1";
    expect(isEnvKillSwitchActive()).toBe(true);
  });
});
